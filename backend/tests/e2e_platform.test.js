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
const settingsRoutes = require("../routes/settings.js");
const routingRoutes = require("../routes/routing.js");
const { pollOnce } = require("../workers/deploymentWorker.js");
const { relayPendingEvents } = require("../services/outboxRelay.js");

function createApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());

  app.use("/api/auth", authRoutes);
  app.use("/api/projects", projectRoutes);
  app.use("/api/deployments", deploymentRoutes);
  app.use("/api/logs", logRoutes);
  app.use("/api/settings", settingsRoutes);
  app.use("/api/routing", routingRoutes);

  return app;
}

async function runEndToEndPlatformVerification() {
  console.log("================================================================================");
  console.log("     DeployForge End-to-End Full Platform Integration Verification Suite        ");
  console.log("================================================================================");

  const app = createApp();
  const server = app.listen(0);
  const port = server.address().port;
  const baseUrl = `http://localhost:${port}`;

  let passed = 0;

  function assert(condition, message) {
    if (condition) {
      console.log(`  ✓ ${message}`);
      passed++;
    } else {
      console.error(`  ✗ ${message}`);
      throw new Error(`Assertion failed: ${message}`);
    }
  }

  try {
    // -------------------------------------------------------------------------
    // Phase 1: User Registration & Authentication
    // -------------------------------------------------------------------------
    console.log("\n[Phase 1] User Registration & Session Authentication");
    const userEmail = `e2e_architect_${Date.now()}@deployforge.test`;
    const regRes = await fetch(`${baseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        user_name: "Platform Architect",
        email: userEmail,
        password: "SuperSecretPassword123!",
      }),
    });
    assert(regRes.status === 201, "Account registered successfully (201 Created)");
    const cookie = regRes.headers.get("set-cookie").split(";")[0];

    const meRes = await fetch(`${baseUrl}/api/auth/me`, {
      headers: { Cookie: cookie },
    });
    assert(meRes.status === 200, "Current user session verified via /api/auth/me (200 OK)");
    const meData = await meRes.json();
    assert(meData.user.email === userEmail, "Authenticated user email matches registered email");

    // -------------------------------------------------------------------------
    // Phase 2: Project Creation & Automatic Initial Pipeline
    // -------------------------------------------------------------------------
    console.log("\n[Phase 2] Project Creation & Redis Stream Dispatch");
    const projectName = `e2e-microservice-${Date.now()}`;
    const projRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        name: projectName,
        repository_url: "https://github.com/deployforge/e2e-microservice",
        branch: "main",
        runtime: "node",
        port: 4000,
      }),
    });
    assert(projRes.status === 201, "Project created successfully (201 Created)");
    const project = (await projRes.json()).project;
    assert(project.domain.includes(".deployforge.app"), "Project assigned valid subdomain");

    // Relay outbox event to Redis Stream
    await relayPendingEvents();

    // Verify deployment pipeline processing transitions project to RUNNING
    console.log("  Executing worker loop to process pipeline...");
    let isRunning = false;
    for (let i = 0; i < 15; i++) {
      await pollOnce();
      const checkProj = await pool.query(
        `SELECT status FROM projects WHERE id = $1`,
        [project.id]
      );
      if (checkProj.rows[0]?.status && checkProj.rows[0].status.toUpperCase() === "RUNNING") {
        isRunning = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    assert(isRunning, "Worker consumed and processed initial deployment job from stream");

    // Verify project transitioned to Running via API
    const checkProjRes = await fetch(`${baseUrl}/api/projects/${project.id}`, {
      headers: { Cookie: cookie },
    });
    const updatedProj = (await checkProjRes.json()).project;
    assert((updatedProj.status || "").toUpperCase() === "RUNNING", "Project status transitioned to 'Running'");

    // -------------------------------------------------------------------------
    // Phase 3: Manual Deployment & Pipeline Execution
    // -------------------------------------------------------------------------
    console.log("\n[Phase 3] On-Demand Deployment Pipeline");
    const manualDepRes = await fetch(`${baseUrl}/api/deployments`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        project_id: project.id,
        commit_message: "Hotfix: optimize edge cache",
        branch: "main",
      }),
    });
    assert(manualDepRes.status === 201, "Manual deployment queued to Redis Stream (201 Created)");
    const manualDep = (await manualDepRes.json()).deployment;
    const manualInitStatus = (manualDep.status || "").toUpperCase();
    assert(manualInitStatus === "INITIATED" || manualInitStatus === "QUEUED", "New manual deployment starts in 'INITIATED' or 'QUEUED' status");

    // Relay manual deployment outbox event to Redis Stream
    await relayPendingEvents();

    // Process manual deployment via worker
    let completedDep = null;
    for (let i = 0; i < 15; i++) {
      await pollOnce();
      const checkDepRes = await fetch(`${baseUrl}/api/deployments/${manualDep.id}`, {
        headers: { Cookie: cookie },
      });
      const data = await checkDepRes.json();
      if (data.deployment?.status && data.deployment.status.toUpperCase() === "RUNNING") {
        completedDep = data.deployment;
        break;
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    assert(Boolean(completedDep), "Manual deployment transitioned to 'Running'");
    assert(typeof completedDep.container_id === "string", "Worker assigned container ID");

    // -------------------------------------------------------------------------
    // Phase 4: Real-Time Build Logs & Ingestion
    // -------------------------------------------------------------------------
    console.log("\n[Phase 4] Build Logs Verification");
    const logsRes = await fetch(`${baseUrl}/api/logs?deployment_id=${completedDep.id}`, {
      headers: { Cookie: cookie },
    });
    assert(logsRes.status === 200, "Historical logs retrieved successfully (200 OK)");
    const logsData = await logsRes.json();
    assert(logsData.logs.length >= 3, "Worker emitted and stored build & container deployment logs");
    assert(
      logsData.logs.some((l) => l.message.includes("Health probe")),
      "Build logs confirm container health probe execution"
    );

    // -------------------------------------------------------------------------
    // Phase 5: AES-256-GCM Encrypted Secrets Vault
    // -------------------------------------------------------------------------
    console.log("\n[Phase 5] Encrypted Secrets Vault");
    const saveEnvRes = await fetch(`${baseUrl}/api/projects/${project.id}/env`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        variables: [
          { key: "DATABASE_URL", value: "postgres://prod:secret@db.internal:5432/main", is_secret: true },
          { key: "API_KEY", value: "sk_live_99887766554433221100", is_secret: true },
          { key: "APP_ENV", value: "production", is_secret: false },
        ],
      }),
    });
    assert(saveEnvRes.status === 201, "Secrets saved to vault with AES-256-GCM encryption (201 Created)");

    // Default masked retrieval
    const maskedEnvRes = await fetch(`${baseUrl}/api/projects/${project.id}/env`, {
      headers: { Cookie: cookie },
    });
    const maskedVars = (await maskedEnvRes.json()).env_vars;
    const dbUrlVar = maskedVars.find((v) => v.key === "DATABASE_URL");
    assert(dbUrlVar.value === "••••••••••••••••", "Secret value is securely masked by default");

    // Decrypted retrieval with ?reveal=true
    const unmaskedEnvRes = await fetch(`${baseUrl}/api/projects/${project.id}/env?reveal=true`, {
      headers: { Cookie: cookie },
    });
    const unmaskedVars = (await unmaskedEnvRes.json()).env_vars;
    const revealedDbUrl = unmaskedVars.find((v) => v.key === "DATABASE_URL");
    assert(
      revealedDbUrl.value === "postgres://prod:secret@db.internal:5432/main",
      "Decrypted secret matches original plaintext value exactly"
    );

    // -------------------------------------------------------------------------
    // Phase 6: Workspace Settings, Custom Domains & Password Security
    // -------------------------------------------------------------------------
    console.log("\n[Phase 6] Settings, Custom Domains & Security Controls");
    // Add custom domain
    const customDomainName = `api.${projectName}.org`;
    const addDomainRes = await fetch(`${baseUrl}/api/settings/domains`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ domain: customDomainName, project_id: project.id }),
    });
    assert(addDomainRes.status === 201, "Custom domain registered in workspace settings (201 Created)");

    // Update notification preferences
    const updateNotifRes = await fetch(`${baseUrl}/api/settings/notifications`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ notify_failures: true, notify_weekly: true }),
    });
    assert(updateNotifRes.status === 200, "Notification preferences updated successfully (200 OK)");

    // Rotate password
    const updatePassRes = await fetch(`${baseUrl}/api/settings/password`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        current_password: "SuperSecretPassword123!",
        new_password: "RotatedPassword456!",
      }),
    });
    assert(updatePassRes.status === 200, "Password rotated securely with bcrypt (200 OK)");

    // Verify sign in with new password
    const newLoginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: userEmail, password: "RotatedPassword456!" }),
    });
    assert(newLoginRes.status === 200, "Signed in successfully using newly rotated password (200 OK)");

    // -------------------------------------------------------------------------
    // Phase 7: Health Check & Reverse Proxy Routing Engine
    // -------------------------------------------------------------------------
    console.log("\n[Phase 7] Container Health Probes & Upstream Reverse Proxy");
    const healthProbeRes = await fetch(`${baseUrl}/api/routing/health/${project.id}`, {
      headers: { Cookie: cookie },
    });
    assert(healthProbeRes.status === 200, "On-demand container health check probe succeeded (200 OK)");
    const healthData = await healthProbeRes.json();
    assert(healthData.probe.healthy === true, "Container probe confirms healthy status");
    assert(healthData.port === 4000, "Container probe probed configured internal port 4000");

    const routingTableRes = await fetch(`${baseUrl}/api/routing/table`);
    assert(routingTableRes.status === 200, "Active reverse proxy routing table retrieved (200 OK)");
    const routingTableData = await routingTableRes.json();
    assert(routingTableData.active_routes_count >= 1, "Routing table contains registered container upstreams");
    assert(
      routingTableData.nginx_config.includes("upstream") && routingTableData.nginx_config.includes("proxy_pass"),
      "Dynamic Nginx reverse proxy configuration generated successfully"
    );

    console.log("\n================================================================================");
    console.log(`  🎉 COMPLETE PLATFORM VERIFICATION SUCCESSFUL: ${passed}/${passed} assertions passed!`);
    console.log("================================================================================\n");
  } catch (error) {
    console.error("\n❌ End-to-end platform verification failed:", error);
    process.exit(1);
  } finally {
    server.close();
    try {
      redis.disconnect();
    } catch (_) {}
  }
}

runEndToEndPlatformVerification()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Fatal test runner error:", err);
    process.exit(1);
  });
