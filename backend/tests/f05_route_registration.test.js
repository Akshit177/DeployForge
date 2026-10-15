const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "../.env") });
require("dotenv").config();

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const pool = require("../config/db.js");
const redis = require("../config/redis.js");
const {
  EVENTS_STREAM,
  ensurePersistenceGroup,
} = require("../services/deploymentEvents.js");
const {
  processEvent,
} = require("../workers/persistenceWorker.js");
const {
  getRoutingTable,
  resolveDomain,
  syncFromDatabase,
  generateNginxConfig,
  unregisterUpstreamRoute,
} = require("../services/proxyRouter.js");
const { checkProjectHealth } = require("../services/healthCheck.js");

describe("F-05: Route Registration on Deployment Events & Container Name Upstreams", () => {
  let testUserId;
  let testProjectId;
  let testDeploymentId;
  const testDomain = `f05-test-${Date.now() % 100000}.deployforge.app`;
  let expectedContainerName;

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
      ["F05 Test User", `f05_${Date.now()}@test.com`, "dummy_hash"]
    );
    testUserId = userRes.rows[0].id;

    // Seed test project with domain and port
    const projRes = await pool.query(
      `INSERT INTO projects (user_id, name, repository_url, domain, port, status)
       VALUES ($1, $2, $3, $4, 4000, 'QUEUED')
       RETURNING id`,
      [testUserId, `f05-app-${Date.now() % 10000}`, "https://github.com/example/repo", testDomain]
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
    expectedContainerName = `df-${testDeploymentId.replace(/-/g, "").slice(0, 12)}`;
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

  it("registers upstream route with container_name as target_host upon DEPLOYMENT_COMPLETED event", async () => {
    const payload = {
      deployment_id: testDeploymentId,
      project_id: testProjectId,
      user_id: testUserId,
      status: "RUNNING",
      stage: "running",
      container_id: `c_${expectedContainerName}`,
      container_name: expectedContainerName,
      domain: testDomain,
      port: 4000,
      duration_seconds: 12,
    };

    const messageId = await redis.xadd(
      EVENTS_STREAM,
      "*",
      "event_type", "DEPLOYMENT_COMPLETED",
      "aggregate_id", testDeploymentId,
      "payload", JSON.stringify(payload),
      "created_at", new Date().toISOString()
    );

    const processed = await processEvent(
      messageId,
      "DEPLOYMENT_COMPLETED",
      JSON.stringify(payload)
    );
    assert.equal(processed, true, "Event processed successfully by persistenceWorker");

    // 1. Verify PostgreSQL deployments row has status RUNNING and container_name set
    const depRes = await pool.query(
      `SELECT status, container_id, container_name, duration_seconds FROM deployments WHERE id = $1`,
      [testDeploymentId]
    );
    assert.equal(depRes.rows.length, 1);
    assert.equal(depRes.rows[0].status, "RUNNING");
    assert.equal(depRes.rows[0].container_name, expectedContainerName);
    assert.equal(depRes.rows[0].duration_seconds, 12);

    // 2. Verify route is registered in proxyRouter
    const route = resolveDomain(testDomain);
    assert.ok(route, "Route is registered in dynamic routing table");
    assert.equal(route.domain, testDomain.toLowerCase());
    assert.equal(route.container_name, expectedContainerName);
    assert.equal(route.target_host, expectedContainerName);
    assert.equal(route.port, 4000);

    // 3. Verify generated Nginx config targets Docker container name, not 127.0.0.1
    const nginxConfig = generateNginxConfig();
    assert.ok(
      nginxConfig.includes(`server ${expectedContainerName}:4000`),
      `Generated Nginx upstream config must target server ${expectedContainerName}:4000`
    );
    assert.ok(
      !nginxConfig.includes(`server 127.0.0.1:4000`),
      "Generated Nginx upstream config must not use 127.0.0.1"
    );
  });

  it("syncFromDatabase() uses container_name from PostgreSQL instead of hardcoded 127.0.0.1", async () => {
    // Clear in-memory route first
    unregisterUpstreamRoute(testDomain);
    assert.equal(resolveDomain(testDomain), null);

    // Run database sync
    const syncedTable = await syncFromDatabase();
    assert.ok(Array.isArray(syncedTable));

    const route = resolveDomain(testDomain);
    assert.ok(route, "Route restored via syncFromDatabase");
    assert.equal(route.container_name, expectedContainerName);
    assert.equal(route.target_host, expectedContainerName, "syncFromDatabase must use container_name, not 127.0.0.1");
    assert.equal(route.port, 4000);

    const nginxConfig = generateNginxConfig();
    assert.ok(
      nginxConfig.includes(`server ${expectedContainerName}:4000`),
      "Nginx config after syncFromDatabase targets container name"
    );
  });

  it("checkProjectHealth returns container_name for project", async () => {
    const health = await checkProjectHealth(testProjectId, testUserId);
    assert.ok(health);
    assert.equal(health.project_id, testProjectId);
    assert.equal(health.domain, testDomain);
    assert.equal(health.container_name, expectedContainerName);
  });

  it("unregisters upstream route on DEPLOYMENT_FAILED or DEPLOYMENT_CANCELLED", async () => {
    assert.ok(resolveDomain(testDomain), "Route exists before failure/cancellation");

    const cancelPayload = {
      deployment_id: testDeploymentId,
      project_id: testProjectId,
      user_id: testUserId,
      status: "Cancelled",
      domain: testDomain,
    };

    const messageId = await redis.xadd(
      EVENTS_STREAM,
      "*",
      "event_type", "DEPLOYMENT_CANCELLED",
      "aggregate_id", testDeploymentId,
      "payload", JSON.stringify(cancelPayload),
      "created_at", new Date().toISOString()
    );

    const processed = await processEvent(
      messageId,
      "DEPLOYMENT_CANCELLED",
      JSON.stringify(cancelPayload)
    );
    assert.equal(processed, true);

    const route = resolveDomain(testDomain);
    assert.equal(route, null, "Route is unregistered after deployment cancellation");
  });
});
