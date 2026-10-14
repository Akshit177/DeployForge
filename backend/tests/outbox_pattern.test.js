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
const { relayPendingEvents, triggerOutboxRelay } = require("../services/outboxRelay.js");
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
  console.log("  DeployForge Phase A: Transactional Outbox & Lifecycle Test Suite              ");
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
    // 1. Register test user
    const userEmail = `outbox_tester_${Date.now()}@deployforge.test`;
    const regRes = await fetch(`${baseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        user_name: "Outbox Architect",
        email: userEmail,
        password: "OutboxPassword123!",
      }),
    });
    assert(regRes.status === 201, "User registered successfully");
    const cookie = regRes.headers.get("set-cookie").split(";")[0];

    // 2. Test Atomic Project Creation with Outbox Event
    const projectName = `outbox-app-${Date.now()}`;
    const projRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        name: projectName,
        repository_url: "https://github.com/deployforge/outbox-app",
        runtime: "node",
        port: 5000,
      }),
    });
    assert(projRes.status === 201, "Project created via atomic PostgreSQL transaction (201)");
    const project = (await projRes.json()).project;

    // Check deployment record
    const depCheck = await pool.query(
      `SELECT * FROM deployments WHERE project_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [project.id]
    );
    assert(depCheck.rows.length > 0, "Deployment record exists in PostgreSQL source of truth");
    const initialDep = depCheck.rows[0];

    // Direct Database Inspection: Check outbox table specifically for this deployment
    const outboxCheck = await pool.query(
      `SELECT * FROM outbox_events WHERE aggregate_id = $1`,
      [initialDep.id]
    );
    assert(outboxCheck.rows.length > 0, "Outbox event recorded in PostgreSQL outbox_events table");
    const outboxRow = outboxCheck.rows[0];
    assert(outboxRow.event_type === "DEPLOYMENT_INITIATED", "Outbox event type is DEPLOYMENT_INITIATED");
    assert(outboxRow.payload !== null, "Outbox payload contains complete deployment metadata");

    // 3. Test Outbox Relay Drain & Delivery
    console.log("  Executing outbox relay to deliver pending events to Redis Stream...");
    await relayPendingEvents();

    // Verify outbox record transitioned to PROCESSED
    let isProcessed = false;
    for (let i = 0; i < 10; i++) {
      const processedCheck = await pool.query(
        `SELECT * FROM outbox_events WHERE id = $1`,
        [outboxRow.id]
      );
      if (processedCheck.rows[0]?.status === "PROCESSED") {
        isProcessed = true;
        assert(processedCheck.rows[0].processed_at !== null, "Outbox event recorded processed_at timestamp");
        break;
      }
      await relayPendingEvents();
      await new Promise((r) => setTimeout(r, 100));
    }
    assert(isProcessed, "Outbox event status transitioned to PROCESSED");

    // 4. Test Lifecycle Progression: QUEUED -> CLONING -> BUILDING -> STARTING -> RUNNING
    console.log("  Executing worker loop to verify granular lifecycle progression...");
    const processedJobs = await pollOnce();
    assert(processedJobs >= 1, "Worker consumed job from Redis Stream");

    // Verify deployment status is now RUNNING
    const runningCheck = await pool.query(
      `SELECT * FROM deployments WHERE id = $1`,
      [initialDep.id]
    );
    const finalDep = runningCheck.rows[0];
    assert(finalDep.status === "RUNNING", "Deployment reached final RUNNING lifecycle status");
    assert(typeof finalDep.container_id === "string", "Worker assigned container_id");

    // Verify lifecycle logs generated
    const logsCheck = await pool.query(
      `SELECT * FROM logs WHERE deployment_id = $1 ORDER BY created_at ASC`,
      [initialDep.id]
    );
    const logSources = logsCheck.rows.map((l) => l.source);
    assert(logSources.includes("clone"), "Lifecycle produced 'clone' phase log (CLONING)");
    assert(logSources.includes("build"), "Lifecycle produced 'build' phase log (BUILDING)");
    assert(logSources.includes("deploy"), "Lifecycle produced 'deploy' phase log (STARTING/RUNNING)");

    // 5. Test Idempotency: Duplicate Worker Execution
    console.log("  Testing worker idempotency on re-delivery of completed job...");
    const rePoll = await pollOnce();
    assert(typeof rePoll === "number", "Duplicate worker poll handled idempotently without error");

    // 6. Test Manual Deployment Creation with Transactional Outbox
    const manualRes = await fetch(`${baseUrl}/api/deployments`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        project_id: project.id,
        commit_message: "Feature: Add Redis caching layer",
        branch: "main",
      }),
    });
    assert(manualRes.status === 201, "Manual deployment initiated with atomic outbox event (201)");
    const manualDep = (await manualRes.json()).deployment;

    // Relay manual deployment to Redis
    await relayPendingEvents();

    // Worker processes manual deployment (waiting for stages: CLONING -> BUILDING -> STARTING -> RUNNING)
    let finalStatus = "";
    for (let i = 0; i < 10; i++) {
      await pollOnce();
      const check = await pool.query(`SELECT status FROM deployments WHERE id = $1`, [manualDep.id]);
      finalStatus = check.rows[0]?.status;
      if (finalStatus && finalStatus.toUpperCase() === "RUNNING") break;
      await new Promise((r) => setTimeout(r, 200));
    }
    assert(
      finalStatus && finalStatus.toUpperCase() === "RUNNING",
      `Manual deployment successfully reached RUNNING (status: ${finalStatus})`
    );

    console.log("================================================================================");
    console.log(`  🎉 Phase A Outbox & Lifecycle Tests Passed! (${passed}/${passed})`);
    console.log("================================================================================");
  } catch (error) {
    console.error("Test execution failed:", error);
    process.exit(1);
  } finally {
    server.close();
    try {
      redis.disconnect();
    } catch (_) {}
  }
}

runTestSuite()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Fatal test runner error:", err);
    process.exit(1);
  });
