const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "../.env") });
require("dotenv").config();

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const pool = require("../config/db.js");
const redis = require("../config/redis.js");
const {
  EVENTS_STREAM,
  PERSISTENCE_GROUP,
  ensurePersistenceGroup,
} = require("../services/deploymentEvents.js");
const {
  processEvent,
  pollPersistenceEvents,
} = require("../workers/persistenceWorker.js");

const EVENTS_DLQ_STREAM = "stream:deployment_events:dlq";

describe("F-01: Deployment Event Envelope and Persistence Consumer Contract", () => {
  let testUserId;
  let testProjectId;
  let testDeploymentId;

  before(async () => {
    await ensurePersistenceGroup();

    // Clean up test stream if needed
    try {
      if (redis.status !== "ready" && redis.status !== "connecting") {
        await redis.connect().catch(() => {});
      }
      await redis.xgroup("SETID", EVENTS_STREAM, PERSISTENCE_GROUP, "$");
    } catch (_) {}

    // Seed test user
    const userRes = await pool.query(
      `INSERT INTO users (name, email, password_hash)
       VALUES ($1, $2, $3)
       RETURNING id`,
      ["Envelope Test User", `envelope_${Date.now()}@test.com`, "dummy_hash"]
    );
    testUserId = userRes.rows[0].id;

    // Seed test project
    const projRes = await pool.query(
      `INSERT INTO projects (user_id, name, repository_url, status)
       VALUES ($1, $2, $3, 'QUEUED')
       RETURNING id`,
      [testUserId, `envelope-proj-${Date.now() % 10000}`, "https://github.com/example/repo"]
    );
    testProjectId = projRes.rows[0].id;

    // Seed test deployment
    const depRes = await pool.query(
      `INSERT INTO deployments (project_id, user_id, status)
       VALUES ($1, $2, 'QUEUED')
       RETURNING id`,
      [testProjectId, testUserId]
    );
    testDeploymentId = depRes.rows[0].id;
  });

  after(async () => {
    try {
      if (testDeploymentId) {
        await pool.query(`DELETE FROM logs WHERE deployment_id = $1`, [testDeploymentId]);
        await pool.query(`DELETE FROM deployments WHERE id = $1`, [testDeploymentId]);
      }
      if (testProjectId) {
        await pool.query(`DELETE FROM projects WHERE id = $1`, [testProjectId]);
      }
      if (testUserId) {
        await pool.query(`DELETE FROM users WHERE id = $1`, [testUserId]);
      }
    } catch (_) {}

    try {
      redis.disconnect();
    } catch (_) {}
    await pool.end();
  });

  it("rejects flat event without 'payload' envelope field gracefully and routes to DLQ", async () => {
    // Legacy unaligned C++ format published flat fields without 'payload'
    const messageId = await redis.xadd(
      EVENTS_STREAM,
      "*",
      "event_type", "STAGE_CHANGED",
      "deployment_id", testDeploymentId,
      "project_id", testProjectId,
      "user_id", testUserId,
      "status", "CLONING",
      "stage", "clone",
      "timestamp", new Date().toISOString()
    );

    assert.ok(messageId, "Message ID returned for flat event");

    // Clear DLQ for clean assertion
    try {
      await redis.del(EVENTS_DLQ_STREAM);
    } catch (_) {}

    // Poll persistence worker
    const processed = await pollPersistenceEvents(5);

    // Flat event is invalid because it lacks envelope 'payload'
    // It should NOT increment processed count
    assert.equal(processed, 0, "Flat event was not processed as valid deployment update");

    // Verify DB was NOT updated (remains QUEUED)
    const dbCheck = await pool.query(
      `SELECT status FROM deployments WHERE id = $1`,
      [testDeploymentId]
    );
    assert.equal(dbCheck.rows[0].status, "QUEUED", "Database status remained QUEUED");

    // Verify event was ACKed from main stream (not stuck in PEL)
    const pel = await redis.xpending(EVENTS_STREAM, PERSISTENCE_GROUP, "-", "+", 100);
    const isPending = Array.isArray(pel) && pel.some((item) => item[0] === messageId);
    assert.equal(isPending, false, "Poison pill message was acknowledged and not left blocking PEL");

    // Verify message arrived in DLQ
    const dlqMessages = await redis.xrevrange(EVENTS_DLQ_STREAM, "+", "-", "COUNT", 1);
    assert.ok(dlqMessages && dlqMessages.length > 0, "Event was routed to DLQ stream");
    const [dlqId, dlqFields] = dlqMessages[0];
    const dlqObj = {};
    for (let i = 0; i < dlqFields.length; i += 2) {
      dlqObj[dlqFields[i]] = dlqFields[i + 1];
    }
    assert.equal(dlqObj.original_message_id, messageId, "DLQ original_message_id matches");
    assert.equal(dlqObj.event_type, "STAGE_CHANGED", "DLQ event_type matches");
    assert.ok(dlqObj.reason.includes("payload"), "DLQ reason indicates missing payload");
  });

  it("correctly parses and applies aligned event envelope with JSON payload", async () => {
    const payload = {
      deployment_id: testDeploymentId,
      project_id: testProjectId,
      user_id: testUserId,
      status: "CLONING",
      stage: "clone",
      duration_seconds: 0,
      timestamp: new Date().toISOString(),
    };

    const messageId = await redis.xadd(
      EVENTS_STREAM,
      "*",
      "event_type", "STAGE_CHANGED",
      "aggregate_id", testDeploymentId,
      "payload", JSON.stringify(payload),
      "created_at", new Date().toISOString()
    );

    assert.ok(messageId, "Message ID returned for envelope event");

    const processed = await pollPersistenceEvents(5);
    assert.ok(processed >= 1, "Persistence worker successfully processed envelope event");

    // Verify DB was updated
    const dbCheck = await pool.query(
      `SELECT status FROM deployments WHERE id = $1`,
      [testDeploymentId]
    );
    assert.equal(dbCheck.rows[0].status, "CLONING", "Deployment status in DB transitioned to CLONING");

    // Verify ACKed from main stream
    const pel = await redis.xpending(EVENTS_STREAM, PERSISTENCE_GROUP, "-", "+", 100);
    const isPending = Array.isArray(pel) && pel.some((item) => item[0] === messageId);
    assert.equal(isPending, false, "Envelope event was acknowledged in Redis");
  });

  it("handles DEPLOYMENT_COMPLETED event matching C++ payload with duration_seconds and container_id", async () => {
    const payload = {
      deployment_id: testDeploymentId,
      project_id: testProjectId,
      user_id: testUserId,
      status: "RUNNING",
      stage: "running",
      container_id: "c_cpp_test_9988",
      duration_seconds: 42,
      timestamp: new Date().toISOString(),
    };

    const messageId = await redis.xadd(
      EVENTS_STREAM,
      "*",
      "event_type", "DEPLOYMENT_COMPLETED",
      "aggregate_id", testDeploymentId,
      "payload", JSON.stringify(payload),
      "created_at", new Date().toISOString()
    );

    assert.ok(messageId);

    const processed = await pollPersistenceEvents(5);
    assert.ok(processed >= 1);

    const dbCheck = await pool.query(
      `SELECT status, container_id, duration_seconds FROM deployments WHERE id = $1`,
      [testDeploymentId]
    );
    assert.equal(dbCheck.rows[0].status, "RUNNING", "Deployment status updated to RUNNING");
    assert.equal(dbCheck.rows[0].container_id, "c_cpp_test_9988", "container_id saved to DB");
    assert.equal(dbCheck.rows[0].duration_seconds, 42, "duration_seconds saved to DB");
  });
});
