const path = require("path");
const fs = require("fs");
require("dotenv").config({ path: path.join(__dirname, "../.env") });
require("dotenv").config();

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const pool = require("../config/db.js");
const redis = require("../config/redis.js");
const {
  STREAM_NAME: JOB_STREAM,
  publishDeploymentJob,
  ensureConsumerGroup: ensureJobGroup,
} = require("../services/queue.js");
const {
  EVENTS_STREAM,
  EVENTS_DLQ_STREAM,
  PERSISTENCE_GROUP,
  ensurePersistenceGroup,
} = require("../services/deploymentEvents.js");
const { processEvent } = require("../workers/persistenceWorker.js");

const CONTRACTS_DIR = path.join(__dirname, "../../docs/contracts");

describe("T-01: Golden JSON Fixture Contract Tests", () => {
  let testUserId;
  let testProjectId;
  let testDeploymentId;

  let jobContract;
  let eventEnvelopeContract;
  let logEnvelopeContract;

  before(async () => {
    // 1. Load golden contract fixtures from disk
    const jobJsonPath = path.join(CONTRACTS_DIR, "job_contract.json");
    const eventJsonPath = path.join(CONTRACTS_DIR, "event_envelope_contract.json");
    const logJsonPath = path.join(CONTRACTS_DIR, "log_envelope_contract.json");

    assert.ok(fs.existsSync(jobJsonPath), "job_contract.json fixture exists");
    assert.ok(fs.existsSync(eventJsonPath), "event_envelope_contract.json fixture exists");
    assert.ok(fs.existsSync(logJsonPath), "log_envelope_contract.json fixture exists");

    jobContract = JSON.parse(fs.readFileSync(jobJsonPath, "utf8"));
    eventEnvelopeContract = JSON.parse(fs.readFileSync(eventJsonPath, "utf8"));
    logEnvelopeContract = JSON.parse(fs.readFileSync(logJsonPath, "utf8"));

    // 2. Ensure Redis groups
    await ensureJobGroup();
    await ensurePersistenceGroup();

    if (redis.status !== "ready" && redis.status !== "connecting") {
      await redis.connect().catch(() => {});
    }

    // Advance event stream cursor
    try {
      await redis.xgroup("SETID", EVENTS_STREAM, PERSISTENCE_GROUP, "$");
    } catch (_) {}

    // 3. Seed test database records
    const userRes = await pool.query(
      `INSERT INTO users (name, email, password_hash)
       VALUES ($1, $2, $3)
       RETURNING id`,
      ["Contract Test User", `contract_${Date.now()}@test.com`, "dummy_hash"]
    );
    testUserId = userRes.rows[0].id;

    const projRes = await pool.query(
      `INSERT INTO projects (user_id, name, repository_url, status)
       VALUES ($1, $2, $3, 'QUEUED')
       RETURNING id`,
      [testUserId, `contract-proj-${Date.now() % 10000}`, "https://github.com/example/repo"]
    );
    testProjectId = projRes.rows[0].id;

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

  it("Test 1: publishDeploymentJob produces stream entry conforming to job_contract.json", async () => {
    const jobPayload = {
      deployment_id: testDeploymentId,
      project_id: testProjectId,
      user_id: testUserId,
      repo_url: jobContract.fields.repo_url,
      branch: jobContract.fields.branch,
      commit_hash: jobContract.fields.commit_hash,
      runtime: jobContract.fields.runtime,
      port: Number(jobContract.fields.port),
      domain: jobContract.fields.domain,
      projectName: jobContract.fields.project_name,
      trigger: "manual",
    };

    const msgId = await publishDeploymentJob(jobPayload);
    assert.ok(msgId, "Job published with message ID");

    // Read back from Redis
    const entries = await redis.xrevrange(JOB_STREAM, "+", "-", "COUNT", 1);
    assert.ok(entries && entries.length > 0, "Read back published job");

    const [, fieldsArr] = entries[0];
    const streamObj = {};
    for (let i = 0; i < fieldsArr.length; i += 2) {
      streamObj[fieldsArr[i]] = fieldsArr[i + 1];
    }

    // Verify all required golden contract keys are present
    for (const key of jobContract.required_keys) {
      assert.ok(
        key in streamObj,
        `Job stream entry must contain golden contract key: ${key}`
      );
      assert.ok(streamObj[key].length > 0, `Value for key ${key} must not be empty`);
    }

    assert.equal(streamObj.deployment_id, testDeploymentId);
    assert.equal(streamObj.project_id, testProjectId);
    assert.equal(streamObj.branch, "main");
    assert.equal(streamObj.port, "3000");
  });

  it("Test 2: persistence worker accepts golden event_envelope_contract.json fixture", async () => {
    const goldenEnvelope = eventEnvelopeContract.envelope;
    const goldenPayload = {
      ...goldenEnvelope.payload,
      deployment_id: testDeploymentId,
      project_id: testProjectId,
      user_id: testUserId,
    };

    const messageId = await redis.xadd(
      EVENTS_STREAM,
      "*",
      "event_type", goldenEnvelope.event_type,
      "aggregate_id", testDeploymentId,
      "payload", JSON.stringify(goldenPayload),
      "created_at", new Date().toISOString()
    );
    assert.ok(messageId);

    const success = await processEvent(
      messageId,
      goldenEnvelope.event_type,
      goldenPayload
    );
    assert.equal(success, true, "processEvent successfully applied golden event envelope");

    // Verify PostgreSQL persistence
    const checkDb = await pool.query(
      `SELECT status, duration_seconds, container_id FROM deployments WHERE id = $1`,
      [testDeploymentId]
    );
    assert.equal(checkDb.rows[0].status, "RUNNING");
    assert.equal(checkDb.rows[0].duration_seconds, 24);
    assert.equal(checkDb.rows[0].container_id, goldenPayload.container_id);
  });

  it("Test 3: persistence worker accepts golden log_envelope_contract.json fixture", async () => {
    const goldenLog = logEnvelopeContract.envelope;
    const goldenPayload = {
      ...goldenLog.payload,
      deployment_id: testDeploymentId,
      project_id: testProjectId,
      user_id: testUserId,
    };

    const messageId = await redis.xadd(
      EVENTS_STREAM,
      "*",
      "event_type", goldenLog.event_type,
      "aggregate_id", testDeploymentId,
      "payload", JSON.stringify(goldenPayload),
      "created_at", new Date().toISOString()
    );
    assert.ok(messageId);

    const success = await processEvent(
      messageId,
      goldenLog.event_type,
      goldenPayload
    );
    assert.equal(success, true, "processEvent successfully applied golden log envelope");

    // Verify PostgreSQL logs table persistence
    const checkLogs = await pool.query(
      `SELECT level, source, message FROM logs WHERE deployment_id = $1 ORDER BY id DESC LIMIT 1`,
      [testDeploymentId]
    );
    assert.ok(checkLogs.rows.length > 0, "Log entry persisted in database");
    assert.equal(checkLogs.rows[0].level, "INFO");
    assert.equal(checkLogs.rows[0].source, "build");
    assert.equal(checkLogs.rows[0].message, goldenPayload.message);
  });

  it("Test 4: event envelope contract violation (missing payload) is dead-lettered", async () => {
    // Clear DLQ
    try {
      await redis.del(EVENTS_DLQ_STREAM);
    } catch (_) {}

    const badMessageId = await redis.xadd(
      EVENTS_STREAM,
      "*",
      "event_type", "STAGE_CHANGED",
      "deployment_id", testDeploymentId
      // Missing 'payload'
    );

    const success = await processEvent(badMessageId, "STAGE_CHANGED", null);
    assert.equal(success, false, "Contract violation rejected by persistence worker");

    const dlq = await redis.xrevrange(EVENTS_DLQ_STREAM, "+", "-", "COUNT", 1);
    assert.ok(dlq && dlq.length > 0, "Violation routed to DLQ stream");
  });
});
