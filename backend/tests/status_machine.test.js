const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "../.env") });
require("dotenv").config();

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const pool = require("../config/db.js");
const redis = require("../config/redis.js");
const {
  DEPLOYMENT_STATUSES,
  TERMINAL_STATUSES,
  normalizeStatus,
  isValidStatus,
  isTerminalStatus,
  canTransition,
  getAllowedPreviousStatuses,
} = require("../services/statusMachine.js");
const {
  EVENTS_STREAM,
  ensurePersistenceGroup,
} = require("../services/deploymentEvents.js");
const { processEvent } = require("../workers/persistenceWorker.js");
const { resolveDomain, unregisterUpstreamRoute } = require("../services/proxyRouter.js");

describe("F-07: Status Machine, Canonical Vocabulary & Transition Guards", () => {
  let testUserId;
  let testProjectId;
  let testDeploymentId;
  const testDomain = `f07-status-${Date.now() % 100000}.deployforge.app`;

  before(async () => {
    await ensurePersistenceGroup();

    try {
      if (redis.status !== "ready" && redis.status !== "connecting") {
        await redis.connect().catch(() => {});
      }
    } catch (_) {}

    // Seed test user
    const userRes = await pool.query(
      `INSERT INTO users (name, email, password_hash)
       VALUES ($1, $2, $3)
       RETURNING id`,
      ["Status Machine User", `status_${Date.now()}@test.com`, "dummy_hash"]
    );
    testUserId = userRes.rows[0].id;

    // Seed test project
    const projRes = await pool.query(
      `INSERT INTO projects (user_id, name, repository_url, domain, status)
       VALUES ($1, $2, $3, $4, 'QUEUED')
       RETURNING id`,
      [testUserId, `status-proj-${Date.now() % 10000}`, "https://github.com/example/repo", testDomain]
    );
    testProjectId = projRes.rows[0].id;
  });

  after(async () => {
    unregisterUpstreamRoute(testDomain);
    try {
      if (testDeploymentId) {
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

  describe("Unit: State Machine Transition Rules", () => {
    it("validates legal lifecycle transitions", () => {
      assert.equal(canTransition("INITIATED", "QUEUED"), true);
      assert.equal(canTransition("QUEUED", "CLONING"), true);
      assert.equal(canTransition("CLONING", "BUILDING"), true);
      assert.equal(canTransition("BUILDING", "STARTING"), true);
      assert.equal(canTransition("STARTING", "RUNNING"), true);
      assert.equal(canTransition("RUNNING", "STOPPED"), true);

      // Early cancellation and failure allowed from active stages
      assert.equal(canTransition("INITIATED", "CANCELLED"), true);
      assert.equal(canTransition("QUEUED", "CANCELLED"), true);
      assert.equal(canTransition("BUILDING", "CANCELLED"), true);
      assert.equal(canTransition("BUILDING", "FAILED"), true);
      assert.equal(canTransition("STARTING", "FAILED"), true);
      assert.equal(canTransition("RUNNING", "FAILED"), true);
    });

    it("permits idempotent self-transitions", () => {
      assert.equal(canTransition("RUNNING", "RUNNING"), true);
      assert.equal(canTransition("BUILDING", "BUILDING"), true);
      assert.equal(canTransition("QUEUED", "QUEUED"), true);
      assert.equal(canTransition("FAILED", "FAILED"), true);
    });

    it("rejects illegal backward regressions and jumps", () => {
      assert.equal(canTransition("RUNNING", "CLONING"), false);
      assert.equal(canTransition("BUILDING", "INITIATED"), false);
      assert.equal(canTransition("STARTING", "QUEUED"), false);
      assert.equal(canTransition("CLONING", "STARTING"), false); // skipped building
    });

    it("strictly prevents resurrection from terminal statuses", () => {
      assert.equal(canTransition("CANCELLED", "RUNNING"), false);
      assert.equal(canTransition("CANCELLED", "BUILDING"), false);
      assert.equal(canTransition("STOPPED", "STARTING"), false);
      assert.equal(canTransition("STOPPED", "RUNNING"), false);
      assert.equal(canTransition("FAILED", "RUNNING"), false);
      assert.equal(canTransition("FAILED", "BUILDING"), false);
    });

    it("normalizes mixed-case strings and rejects invalid statuses", () => {
      assert.equal(canTransition("building", "starting"), true);
      assert.equal(canTransition("Running", "Stopped"), true);
      assert.equal(canTransition("INVALID_STATUS", "RUNNING"), false);
      assert.equal(canTransition("QUEUED", "NONEXISTENT"), false);
    });

    it("computes allowed previous statuses accurately", () => {
      const allowedToRunning = getAllowedPreviousStatuses("RUNNING");
      assert.ok(allowedToRunning.includes("STARTING"));
      assert.ok(allowedToRunning.includes("RUNNING"));
      assert.equal(allowedToRunning.includes("CANCELLED"), false);
      assert.equal(allowedToRunning.includes("STOPPED"), false);
      assert.equal(allowedToRunning.includes("FAILED"), false);

      const allowedToCancelled = getAllowedPreviousStatuses("CANCELLED");
      assert.ok(allowedToCancelled.includes("INITIATED"));
      assert.ok(allowedToCancelled.includes("QUEUED"));
      assert.ok(allowedToCancelled.includes("BUILDING"));
      assert.ok(allowedToCancelled.includes("RUNNING"));
      assert.equal(allowedToCancelled.includes("FAILED"), false);
    });
  });

  describe("Integration: Persistence Worker Late-Event Resilience", () => {
    it("ignores late DEPLOYMENT_COMPLETED event on already CANCELLED deployment", async () => {
      // 1. Create deployment in CANCELLED status
      const depRes = await pool.query(
        `INSERT INTO deployments (project_id, user_id, status)
         VALUES ($1, $2, 'CANCELLED')
         RETURNING id`,
        [testProjectId, testUserId]
      );
      testDeploymentId = depRes.rows[0].id;
      const containerName = `df-${testDeploymentId.replace(/-/g, "").slice(0, 12)}`;

      // 2. Simulate late DEPLOYMENT_COMPLETED event arriving from a worker
      const latePayload = {
        deployment_id: testDeploymentId,
        project_id: testProjectId,
        user_id: testUserId,
        status: "RUNNING",
        container_id: `c_${containerName}`,
        container_name: containerName,
        domain: testDomain,
        port: 3000,
        duration_seconds: 25,
      };

      const messageId = await redis.xadd(
        EVENTS_STREAM,
        "*",
        "event_type", "DEPLOYMENT_COMPLETED",
        "aggregate_id", testDeploymentId,
        "payload", JSON.stringify(latePayload),
        "created_at", new Date().toISOString()
      );

      // Process event through persistenceWorker
      await processEvent(
        messageId,
        "DEPLOYMENT_COMPLETED",
        JSON.stringify(latePayload)
      );

      // 3. Verify status in database remains CANCELLED (not resurrected to RUNNING)
      const checkRes = await pool.query(
        `SELECT status FROM deployments WHERE id = $1`,
        [testDeploymentId]
      );
      assert.equal(checkRes.rows[0].status, "CANCELLED", "Deployment status must not be resurrected from CANCELLED to RUNNING");

      // 4. Verify route was NOT registered in proxy router
      const route = resolveDomain(testDomain);
      assert.equal(route, null, "Route must not be registered for a cancelled deployment");
    });
  });

  describe("Database: PostgreSQL CHECK Constraint", () => {
    it("enforces chk_deployments_status CHECK constraint on invalid status strings", async () => {
      let rejected = false;
      try {
        await pool.query(
          `INSERT INTO deployments (project_id, user_id, status)
           VALUES ($1, $2, 'INVALID_STATUS_STRING')`,
          [testProjectId, testUserId]
        );
      } catch (err) {
        rejected = true;
        assert.ok(
          err.message.includes("chk_deployments_status") || err.code === "23514",
          `Expected check constraint error, got: ${err.message}`
        );
      }
      assert.equal(rejected, true, "Invalid status insertion must be rejected by PostgreSQL CHECK constraint");
    });
  });
});
