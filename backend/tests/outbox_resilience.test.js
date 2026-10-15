const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "../.env") });
require("dotenv").config();

const pool = require("../config/db.js");
const redis = require("../config/redis.js");
const queue = require("../services/queue.js");
const {
  relayPendingEvents,
  reapStuckDeployments,
  MAX_RETRIES,
} = require("../services/outboxRelay.js");

describe("F-06: Outbox Resilience and Redis Outage Handling", () => {
  let testUserId;
  let testProjectId;

  before(async () => {
    // Ensure database migration has run
    const { runMigrations } = require("../database/migrate.js");
    await runMigrations();

    // Create a test user and project
    const userRes = await pool.query(
      `INSERT INTO users (name, email, password_hash)
       VALUES ('Outbox Resilience User', $1, 'hashed_pw')
       RETURNING id`,
      [`outbox_resilience_${Date.now()}@example.com`]
    );
    testUserId = userRes.rows[0].id;

    const projRes = await pool.query(
      `INSERT INTO projects (user_id, name, repository_url, domain)
       VALUES ($1, $2, 'https://github.com/deployforge/sample-node', $3)
       RETURNING id`,
      [testUserId, `outbox-proj-${Date.now()}`, `resilience-${Date.now()}.deployforge.app`]
    );
    testProjectId = projRes.rows[0].id;
  });

  after(async () => {
    try {
      if (testUserId) {
        await pool.query(`DELETE FROM users WHERE id = $1`, [testUserId]);
      }
      await pool.end();
      redis.disconnect();
    } catch (_) {}
  });

  it("publishDeploymentJob throws an error when Redis XADD fails", async () => {
    const origXadd = redis.xadd;
    redis.xadd = async () => {
      throw new Error("Simulated Redis Connection Loss");
    };

    try {
      await assert.rejects(
        async () => {
          await queue.publishDeploymentJob({
            deployment_id: "test-rejection",
            project_id: testProjectId,
            user_id: testUserId,
          });
        },
        /Simulated Redis Connection Loss/
      );
    } finally {
      redis.xadd = origXadd;
    }
  });

  it("event stays PENDING, retry_count increments, and deployment remains INITIATED during Redis outage", async () => {
    // 1. Create a deployment and pending outbox event
    const depRes = await pool.query(
      `INSERT INTO deployments (project_id, user_id, status, branch, commit_message)
       VALUES ($1, $2, 'INITIATED', 'main', 'Outbox failure test')
       RETURNING id`,
      [testProjectId, testUserId]
    );
    const deploymentId = depRes.rows[0].id;

    const outboxRes = await pool.query(
      `INSERT INTO outbox_events (aggregate_type, aggregate_id, event_type, payload, status, retry_count)
       VALUES ('DEPLOYMENT', $1, 'DEPLOYMENT_INITIATED', $2, 'PENDING', 0)
       RETURNING id`,
      [
        deploymentId,
        JSON.stringify({
          deployment_id: deploymentId,
          project_id: testProjectId,
          user_id: testUserId,
          repo_url: "https://github.com/deployforge/sample-node",
        }),
      ]
    );
    const eventId = outboxRes.rows[0].id;

    // 2. Simulate Redis outage by mocking publishDeploymentJob to throw
    const origPublish = queue.publishDeploymentJob;
    queue.publishDeploymentJob = async () => {
      throw new Error("Redis cluster node down");
    };

    try {
      await relayPendingEvents();

      // Verify event is still PENDING and retry_count is 1
      const checkEvent = await pool.query(`SELECT * FROM outbox_events WHERE id = $1`, [eventId]);
      const eventRow = checkEvent.rows[0];

      assert.equal(eventRow.status, "PENDING", "Event must stay PENDING during Redis outage");
      assert.equal(eventRow.retry_count, 1, "retry_count must increment to 1");
      assert.ok(eventRow.error_message.includes("Redis cluster node down"));
      assert.ok(eventRow.next_retry_at !== null, "next_retry_at must be populated for backoff");

      // Verify deployment remains INITIATED (did not transition to QUEUED)
      const checkDep = await pool.query(`SELECT status FROM deployments WHERE id = $1`, [deploymentId]);
      assert.equal(checkDep.rows[0].status, "INITIATED", "Deployment must remain INITIATED while event is pending");

      // 3. Simulate Redis recovery
      queue.publishDeploymentJob = origPublish;

      // Reset next_retry_at to NOW() so relay picks it up immediately
      await pool.query(`UPDATE outbox_events SET next_retry_at = NOW() - INTERVAL '1 second' WHERE id = $1`, [eventId]);

      await relayPendingEvents();

      // Verify event transitioned to PROCESSED and deployment transitioned to QUEUED
      const recoveredEvent = await pool.query(`SELECT * FROM outbox_events WHERE id = $1`, [eventId]);
      assert.equal(recoveredEvent.rows[0].status, "PROCESSED", "Event transitions to PROCESSED upon Redis recovery");
      assert.ok(recoveredEvent.rows[0].processed_at !== null);

      const recoveredDep = await pool.query(`SELECT status FROM deployments WHERE id = $1`, [deploymentId]);
      assert.equal(recoveredDep.rows[0].status, "QUEUED", "Deployment transitions to QUEUED upon delivery to Redis");
    } finally {
      queue.publishDeploymentJob = origPublish;
    }
  });

  it("marks event and deployment as FAILED when max retries is exceeded", async () => {
    const depRes = await pool.query(
      `INSERT INTO deployments (project_id, user_id, status, branch, commit_message)
       VALUES ($1, $2, 'INITIATED', 'main', 'Poison event test')
       RETURNING id`,
      [testProjectId, testUserId]
    );
    const deploymentId = depRes.rows[0].id;

    // Create event with retry_count = MAX_RETRIES - 1
    const outboxRes = await pool.query(
      `INSERT INTO outbox_events (aggregate_type, aggregate_id, event_type, payload, status, retry_count)
       VALUES ('DEPLOYMENT', $1, 'DEPLOYMENT_INITIATED', $2, 'PENDING', $3)
       RETURNING id`,
      [
        deploymentId,
        JSON.stringify({
          deployment_id: deploymentId,
          project_id: testProjectId,
          user_id: testUserId,
        }),
        MAX_RETRIES - 1,
      ]
    );
    const eventId = outboxRes.rows[0].id;

    const origPublish = queue.publishDeploymentJob;
    queue.publishDeploymentJob = async () => {
      throw new Error("Permanent fatal transport error");
    };

    try {
      await relayPendingEvents();

      const deadEvent = (await pool.query(`SELECT * FROM outbox_events WHERE id = $1`, [eventId])).rows[0];
      assert.equal(deadEvent.status, "FAILED");
      assert.equal(deadEvent.retry_count, MAX_RETRIES);
      assert.ok(deadEvent.error_message.includes("Exceeded max retries"));

      const deadDep = (await pool.query(`SELECT * FROM deployments WHERE id = $1`, [deploymentId])).rows[0];
      assert.equal(deadDep.status, "FAILED");
      assert.ok(deadDep.error_message.includes("Outbox delivery failed"));
    } finally {
      queue.publishDeploymentJob = origPublish;
    }
  });

  it("reaper reaps stuck INITIATED deployments without active outbox tasks", async () => {
    // Insert a deployment with created_at 30 minutes in the past and no pending outbox event
    const oldDepRes = await pool.query(
      `INSERT INTO deployments (project_id, user_id, status, branch, commit_message, created_at)
       VALUES ($1, $2, 'INITIATED', 'main', 'Old stuck deployment', NOW() - INTERVAL '30 minutes')
       RETURNING id`,
      [testProjectId, testUserId]
    );
    const oldDepId = oldDepRes.rows[0].id;

    // Run reaper with threshold of 10 minutes
    const reaped = await reapStuckDeployments(10);
    const reapedIds = reaped.map((r) => r.id);

    assert.ok(reapedIds.includes(oldDepId), "Reaper must reap deployment older than 10 minutes");

    const reapedDep = (await pool.query(`SELECT * FROM deployments WHERE id = $1`, [oldDepId])).rows[0];
    assert.equal(reapedDep.status, "FAILED", "Reaped deployment must be transitioned to FAILED");
    assert.ok(reapedDep.error_message.includes("Deployment timed out"));
  });
});
