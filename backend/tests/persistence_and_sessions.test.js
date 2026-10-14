const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "../.env") });
require("dotenv").config();

const express = require("express");
const cookieParser = require("cookie-parser");
const pool = require("../config/db.js");
const redis = require("../config/redis.js");
const authRoutes = require("../routes/auth.js");
const projectRoutes = require("../routes/projects.js");
const deploymentRoutes = require("../routes/deployments.js");
const logRoutes = require("../routes/logs.js");
const { getSession, destroySession } = require("../services/sessionService.js");
const { setDeploymentHotState, getDeploymentHotState, deleteDeploymentHotState } = require("../services/hotState.js");
const {
  EVENTS_STREAM,
  PERSISTENCE_GROUP,
  publishDeploymentEvent,
  ensurePersistenceGroup,
} = require("../services/deploymentEvents.js");
const {
  pollPersistenceEvents,
  drainPersistenceEvents,
} = require("../workers/persistenceWorker.js");
const { pollOnce } = require("../workers/deploymentWorker.js");

function createApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use("/api/auth", authRoutes);
  app.use("/api/projects", projectRoutes);
  app.use("/api/deployments", deploymentRoutes);
  app.use("/api/logs", logRoutes);
  return app;
}

async function runTestSuite() {
  console.log("================================================================================");
  console.log("  DeployForge Phase B: Redis Hot State, Sessions & Persistence Worker Tests     ");
  console.log("================================================================================");

  const app = createApp();
  const server = app.listen(0);
  const port = server.address().port;
  const baseUrl = `http://localhost:${port}`;

  let passed = 0;
  let failed = 0;

  function assert(condition, message) {
    if (condition) {
      console.log(`  ✓ ${message}`);
      passed++;
    } else {
      console.error(`  ✗ ${message}`);
      failed++;
      throw new Error(`Assertion failed: ${message}`);
    }
  }

  try {
    // -------------------------------------------------------------
    // PART 1: Redis Session Management & Instant Revocation
    // -------------------------------------------------------------
    console.log("\n[Part 1] Redis Session Store & Fast-Path Authentication");

    const email = `session_user_${Date.now()}@test.com`;
    const regRes = await fetch(`${baseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        user_name: "Session User",
        email,
        password: "SecurePassword123!",
      }),
    });

    assert(regRes.status === 201, "Account registered successfully (201)");
    const regData = await regRes.json();
    assert(Boolean(regData.session_id), "Register response includes session_id");
    const sessionId = regData.session_id;

    const cookie = regRes.headers.get("set-cookie").split(";")[0];
    assert(Boolean(cookie), "Received HttpOnly authentication cookie");

    // Verify session data is present in Redis
    const sessionInRedis = await getSession(sessionId);
    assert(Boolean(sessionInRedis), "Session record exists in Redis (session:<id>)");
    assert(sessionInRedis.email === email.toLowerCase(), "Session in Redis contains user email");
    assert(sessionInRedis.user_name === "Session User", "Session in Redis contains user name");

    // Fast-path /api/auth/me verification
    const meRes = await fetch(`${baseUrl}/api/auth/me`, {
      headers: { Cookie: cookie },
    });
    assert(meRes.status === 200, "GET /api/auth/me resolved successfully (200 OK)");
    const meData = await meRes.json();
    assert(meData.session_id === sessionId, "GET /api/auth/me reports matching session_id");

    // Instant Revocation via Logout
    console.log("  Testing instant server-side revocation on logout...");
    const logoutRes = await fetch(`${baseUrl}/api/auth/logout`, {
      method: "POST",
      headers: { Cookie: cookie },
    });
    assert(logoutRes.status === 200, "POST /api/auth/logout returned 200 OK");

    const sessionAfterLogout = await getSession(sessionId);
    assert(sessionAfterLogout === null, "Redis session key destroyed immediately on logout");

    // The logged-out cookie must now be rejected
    const revokedCheck = await fetch(`${baseUrl}/api/auth/me`, {
      headers: { Cookie: cookie },
    });
    assert(revokedCheck.status === 401, "Reusing revoked token is immediately rejected with 401");

    // -------------------------------------------------------------
    // PART 2: Redis Hot Deployment State
    // -------------------------------------------------------------
    console.log("\n[Part 2] Redis Hot Deployment State (deployment:<id>:state)");

    // Log back in to get a fresh active session
    const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email,
        password: "SecurePassword123!",
      }),
    });
    assert(loginRes.status === 200, "Login succeeded for hot state tests");
    const loginCookie = loginRes.headers.get("set-cookie").split(";")[0];

    // Create a project
    const projRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: loginCookie },
      body: JSON.stringify({
        name: `hot-state-proj-${Date.now() % 10000}`,
        repository_url: "https://github.com/acme/hot-state-app",
        runtime: "node",
        port: 4200,
      }),
    });
    assert(projRes.status === 201, "Project created for hot state tests (201)");
    const projData = await projRes.json();
    const projectId = projData.project.id;
    const testUserId = sessionInRedis.id;

    const depCheck = await pool.query(
      `SELECT id FROM deployments WHERE project_id = $1 ORDER BY created_at ASC LIMIT 1`,
      [projectId]
    );
    assert(depCheck.rows.length > 0, "Initial deployment record exists in database");
    const initialDeployId = depCheck.rows[0].id;

    // Test direct hot state API
    const testHotPayload = {
      project_id: projectId,
      status: "BUILDING",
      stage: "build",
      progress_pct: 65,
      domain: projData.project.domain,
      port: 4200,
    };

    const setOk = await setDeploymentHotState(initialDeployId, testHotPayload);
    assert(setOk === true, "setDeploymentHotState successfully wrote to Redis");

    const readHot = await getDeploymentHotState(initialDeployId);
    assert(Boolean(readHot), "getDeploymentHotState retrieved hot state from Redis");
    assert(readHot.status === "BUILDING", "Hot state status matches 'BUILDING'");
    assert(readHot.progress_pct === 65, "Hot state progress percentage matches 65");
    assert(readHot.port === 4200, "Hot state internal port matches 4200");

    // Test GET /api/deployments/:id/live
    const liveRes = await fetch(`${baseUrl}/api/deployments/${initialDeployId}/live`, {
      headers: { Cookie: loginCookie },
    });
    assert(liveRes.status === 200, "GET /api/deployments/:id/live returned 200 OK");
    const liveData = await liveRes.json();
    assert(liveData.live === true, "Live response reports live: true (from Redis cache)");
    assert(liveData.hot_state.stage === "build", "Live response contains hot state stage");

    // Clean up hot state test key
    await deleteDeploymentHotState(initialDeployId);
    const readAfterDel = await getDeploymentHotState(initialDeployId);
    assert(readAfterDel === null, "deleteDeploymentHotState successfully cleared Redis key");

    // -------------------------------------------------------------
    // PART 3: Redis Event Stream & Dedicated Persistence Worker
    // -------------------------------------------------------------
    console.log("\n[Part 3] Redis Event Stream & Dedicated Persistence Worker");

    await ensurePersistenceGroup();

    // 1. Manually publish a STAGE_CHANGED event
    const eventId1 = await publishDeploymentEvent("STAGE_CHANGED", {
      deployment_id: initialDeployId,
      project_id: projectId,
      user_id: testUserId,
      status: "CLONING",
      stage: "clone",
      log: {
        level: "STEP",
        source: "clone",
        message: "Cloning test repository via persistence worker",
      },
    });
    assert(Boolean(eventId1), `Published STAGE_CHANGED event to ${EVENTS_STREAM} (ID: ${eventId1})`);

    // 2. Poll persistence worker to process event
    const processed1 = await pollPersistenceEvents(5);
    assert(processed1 >= 1, "Persistence worker successfully consumed event from Redis");

    // 3. Verify PostgreSQL transaction was committed
    const depCheck1 = await pool.query(
      `SELECT status FROM deployments WHERE id = $1`,
      [initialDeployId]
    );
    assert(depCheck1.rows[0].status === "CLONING", "PostgreSQL deployment status updated to 'CLONING' via persistence transaction");

    // 4. Verify Redis XACK: Pending Entries List (PEL) count must be 0 for this message
    const pel = await redis.xpending(EVENTS_STREAM, PERSISTENCE_GROUP);
    assert(pel[0] === 0, "Redis event message was acknowledged (XACK) after database COMMIT (PEL is 0)");

    // 5. Test DEPLOYMENT_COMPLETED event
    const eventId2 = await publishDeploymentEvent("DEPLOYMENT_COMPLETED", {
      deployment_id: initialDeployId,
      project_id: projectId,
      user_id: testUserId,
      status: "RUNNING",
      container_id: "c_persist_test_999",
      duration_seconds: 35,
      domain: projData.project.domain,
      log: {
        level: "INFO",
        source: "deploy",
        message: "Deployment completed and verified healthy",
      },
    });

    const processed2 = await pollPersistenceEvents(5);
    assert(processed2 >= 1, "Persistence worker processed DEPLOYMENT_COMPLETED event");

    const depCheck2 = await pool.query(
      `SELECT status, container_id, duration_seconds FROM deployments WHERE id = $1`,
      [initialDeployId]
    );
    assert(depCheck2.rows[0].status === "RUNNING", "Durable PostgreSQL deployment status is 'RUNNING'");
    assert(depCheck2.rows[0].container_id === "c_persist_test_999", "Durable container_id matches persistence payload");
    assert(depCheck2.rows[0].duration_seconds === 35, "Durable duration_seconds matches persistence payload");

    // 6. Test Logs were persisted to logs table
    const logsRes = await pool.query(
      `SELECT level, source, message FROM logs WHERE deployment_id = $1`,
      [initialDeployId]
    );
    assert(logsRes.rows.length >= 2, "Persistence worker inserted logs into PostgreSQL logs table");

    // -------------------------------------------------------------
    // PART 4: End-to-End Worker Pipeline with Hot State & Persistence
    // -------------------------------------------------------------
    console.log("\n[Part 4] End-to-End Pipeline with Hot State & Event Persistence");

    // Trigger a new deployment via API
    const triggerRes = await fetch(`${baseUrl}/api/deployments`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: loginCookie },
      body: JSON.stringify({
        project_id: projectId,
        commit_message: "Testing complete Phase B pipeline",
        branch: "main",
      }),
    });
    assert(triggerRes.status === 201, "Triggered manual deployment via API (201)");
    const newDeployData = await triggerRes.json();
    const newDeployId = newDeployData.deployment.id;

    // Drain outbox to Redis Stream
    const { relayPendingEvents } = require("../services/outboxRelay.js");
    await relayPendingEvents();

    // Process job with deployment worker
    let attempts = 0;
    while (attempts < 15) {
      await pollOnce();
      const check = await pool.query(
        `SELECT status FROM deployments WHERE id = $1`,
        [newDeployId]
      );
      if (check.rows[0]?.status && check.rows[0].status.toUpperCase() === "RUNNING") {
        break;
      }
      attempts++;
    }

    // Verify final state in both Redis Hot State and PostgreSQL
    const finalHot = await getDeploymentHotState(newDeployId);
    assert(Boolean(finalHot), "New deployment recorded hot state in Redis");
    assert(finalHot.status === "RUNNING", "Hot state status is 'RUNNING'");
    assert(Boolean(finalHot.container_id), "Hot state contains container_id");

    const finalDb = await pool.query(
      `SELECT status, container_id FROM deployments WHERE id = $1`,
      [newDeployId]
    );
    assert(finalDb.rows[0].status.toUpperCase() === "RUNNING", "Durable PostgreSQL status is 'RUNNING'");
    assert(Boolean(finalDb.rows[0].container_id), "Durable PostgreSQL container_id assigned");

    console.log("\n================================================================================");
    console.log(`  🎉 Phase B Tests Passed! (${passed}/${passed} assertions)`);
    console.log("================================================================================\n");
  } finally {
    if (server) server.close();
    redis.disconnect();
    await pool.end();
  }
}

runTestSuite().catch((err) => {
  console.error("Test execution failed:", err);
  process.exit(1);
});
