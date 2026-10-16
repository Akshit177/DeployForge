const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "../.env") });
require("dotenv").config();

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const pool = require("../config/db.js");
const redis = require("../config/redis.js");
const { checkProjectHealth, probeContainerEndpoint } = require("../services/healthCheck.js");

describe("F-14: Container DNS Health Probe & Readiness", () => {
  let testUserId;
  let testProjectId;
  let runningDepId;
  let stoppedProjectId;
  const runningContainerName = `df-f14-${Date.now() % 100000}`;
  const stoppedContainerName = `df-stopped-${Date.now() % 100000}`;

  before(async () => {
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
      ["F14 Test User", `f14_${Date.now()}@test.com`, "dummy_hash"]
    );
    testUserId = userRes.rows[0].id;

    // 1. Seed running project & deployment
    const projRes = await pool.query(
      `INSERT INTO projects (user_id, name, repository_url, domain, port, status)
       VALUES ($1, $2, $3, $4, 4200, 'RUNNING')
       RETURNING id`,
      [testUserId, `f14-active-${Date.now() % 10000}`, "https://github.com/example/repo", `f14-active-${Date.now() % 10000}.deployforge.app`]
    );
    testProjectId = projRes.rows[0].id;

    const depRes = await pool.query(
      `INSERT INTO deployments (project_id, user_id, status, container_name, container_id)
       VALUES ($1, $2, 'RUNNING', $3, 'c_f14_active_123')
       RETURNING id`,
      [testProjectId, testUserId, runningContainerName]
    );
    runningDepId = depRes.rows[0].id;

    // 2. Seed stopped project with no running deployment
    const stoppedProjRes = await pool.query(
      `INSERT INTO projects (user_id, name, repository_url, domain, port, status)
       VALUES ($1, $2, $3, $4, 4300, 'STOPPED')
       RETURNING id`,
      [testUserId, `f14-stopped-${Date.now() % 10000}`, "https://github.com/example/repo", `f14-stopped-${Date.now() % 10000}.deployforge.app`]
    );
    stoppedProjectId = stoppedProjRes.rows[0].id;

    await pool.query(
      `INSERT INTO deployments (project_id, user_id, status, container_name, container_id)
       VALUES ($1, $2, 'STOPPED', $3, 'c_f14_stopped_123')`,
      [stoppedProjectId, testUserId, stoppedContainerName]
    );
  });

  after(async () => {
    try {
      if (testUserId) {
        await pool.query("DELETE FROM users WHERE id = $1", [testUserId]);
      }
    } catch (_) {}

    try {
      redis.disconnect();
    } catch (_) {}
    await pool.end();
  });

  it("Test 1: checkProjectHealth probes container_name instead of hardcoded 127.0.0.1", async () => {
    const health = await checkProjectHealth(testProjectId, testUserId);
    assert.ok(health);
    assert.equal(health.project_id, testProjectId);
    assert.equal(health.container_name, runningContainerName, "Targets container_name from active deployment");
    assert.equal(health.port, 4200);
    assert.equal(health.probe.healthy, true, "Running deployment is reported healthy in simulator");
  });

  it("Test 2: Stopped project with no RUNNING deployment returns healthy: false (no false-positive healthy: true)", async () => {
    const health = await checkProjectHealth(stoppedProjectId, testUserId);
    assert.ok(health);
    assert.equal(health.probe.healthy, false, "Stopped project must NOT be reported as healthy");
    assert.equal(health.probe.status_code, 503, "Status code is 503 Service Unavailable");
    assert.match(health.probe.error, /No active running deployment/i);
  });

  it("Test 3: probeContainerEndpoint on failing/unhealthy host returns healthy: false", async () => {
    const failProbe = await probeContainerEndpoint({ host: "df-fail-container", port: 3000, timeoutMs: 100 });
    assert.equal(failProbe.healthy, false, "Failing container is marked healthy: false");

    const crashProbe = await probeContainerEndpoint({ host: "df-crash-app", port: 3000, timeoutMs: 100 });
    assert.equal(crashProbe.healthy, false, "Crash container is marked healthy: false");
  });
});
