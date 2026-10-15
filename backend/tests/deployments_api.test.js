const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "../.env") });
require("dotenv").config();

const express = require("express");
const cookieParser = require("cookie-parser");
const pool = require("../config/db.js");
const authRoutes = require("../routes/auth.js");
const projectRoutes = require("../routes/projects.js");
const deploymentRoutes = require("../routes/deployments.js");

function createApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use("/api/auth", authRoutes);
  app.use("/api/projects", projectRoutes);
  app.use("/api/deployments", deploymentRoutes);
  return app;
}

async function runTestSuite() {
  console.log("==================================================");
  console.log("  DeployForge Deployments API End-to-End Tests   ");
  console.log("==================================================");

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
    // 1. Unauthenticated requests
    const unauthGet = await fetch(`${baseUrl}/api/deployments`);
    assert(unauthGet.status === 401, "GET /api/deployments without token returns 401 Unauthorized");

    const unauthPost = await fetch(`${baseUrl}/api/deployments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project_id: "00000000-0000-0000-0000-000000000000" }),
    });
    assert(unauthPost.status === 401, "POST /api/deployments without token returns 401 Unauthorized");

    // 2. Register user A
    const userAEmail = `deploy_user_a_${Date.now()}@test.com`;
    const regResA = await fetch(`${baseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        user_name: "Deployer A",
        email: userAEmail,
        password: "StrongPassword123!",
      }),
    });
    assert(regResA.status === 201, "User A registered successfully");
    const cookieHeaderA = regResA.headers.get("set-cookie");
    const tokenCookieA = cookieHeaderA ? cookieHeaderA.split(";")[0] : "";

    // 3. Create project for user A (should auto-create deployment #1)
    const createProjectRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: tokenCookieA },
      body: JSON.stringify({
        name: `pipeline-app-${Date.now() % 10000}`,
        repository_url: "https://github.com/acme/pipeline-app",
        branch: "main",
        runtime: "node",
        port: 3000,
      }),
    });
    assert(createProjectRes.status === 201, "Project created successfully");
    const projectData = await createProjectRes.json();
    const projectId = projectData.project.id;

    // 4. Verify initial deployment auto-created
    const listRes1 = await fetch(`${baseUrl}/api/deployments?project_id=${projectId}`, {
      headers: { Cookie: tokenCookieA },
    });
    const listData1 = await listRes1.json();
    assert(listRes1.status === 200, "GET /api/deployments returned 200");
    assert(listData1.deployments.length >= 1, "Initial deployment was automatically created in the pipeline");
    const initialDeploy = listData1.deployments[0];
    const initialStatus = (initialDeploy.status || "").toUpperCase();
    assert(initialStatus === "INITIATED" || initialStatus === "QUEUED", "Initial deployment is INITIATED or QUEUED");
    assert(initialDeploy.project_id === projectId, "Initial deployment belongs to the project");
    const deployId1 = initialDeploy.id;
    const deployNum1 = initialDeploy.deployment_number;

    // 5. Trigger a second deployment manually
    const manualDeployRes = await fetch(`${baseUrl}/api/deployments`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: tokenCookieA },
      body: JSON.stringify({
        project_id: projectId,
        branch: "feature-branch",
        commit_hash: "a1b2c3d",
        commit_message: "feat: add redis cache",
      }),
    });
    assert(manualDeployRes.status === 201, "POST /api/deployments returned 201 Created");
    const manualData = await manualDeployRes.json();
    assert(manualData.deployment.commit === "a1b2c3d", "Manual deployment recorded commit SHA");
    const deployId2 = manualData.deployment.id;

    // 6. GET /api/deployments/:id by UUID
    const singleResUuid = await fetch(`${baseUrl}/api/deployments/${deployId1}`, {
      headers: { Cookie: tokenCookieA },
    });
    const singleDataUuid = await singleResUuid.json();
    assert(singleResUuid.status === 200 && singleDataUuid.deployment.id === deployId1, "Lookup by UUID succeeded");

    // 7. GET /api/deployments/:number by deployment_number
    const singleResNum = await fetch(`${baseUrl}/api/deployments/${deployNum1}`, {
      headers: { Cookie: tokenCookieA },
    });
    const singleDataNum = await singleResNum.json();
    assert(singleResNum.status === 200 && singleDataNum.deployment.id === deployId1, "Lookup by deployment number succeeded");

    // 8. Verify PATCH /api/deployments/:id/status is removed (404)
    const patchAttempt = await fetch(`${baseUrl}/api/deployments/${deployId1}/status`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: tokenCookieA },
      body: JSON.stringify({ status: "Building", duration_seconds: 15 }),
    });
    assert(patchAttempt.status === 404, "PATCH /api/deployments/:id/status returns 404 (removed)");

    // Simulate worker/consumer updating durable state to RUNNING
    await pool.query(
      `UPDATE deployments
       SET status = 'RUNNING', duration_seconds = 48, container_id = 'cont-12345-abc', updated_at = NOW()
       WHERE id = $1`,
      [deployId1]
    );
    await pool.query(
      `UPDATE projects SET status = 'RUNNING', updated_at = NOW() WHERE id = $1`,
      [projectId]
    );

    const getRunning = await fetch(`${baseUrl}/api/deployments/${deployId1}`, {
      headers: { Cookie: tokenCookieA },
    });
    assert(getRunning.status === 200, "Retrieved updated deployment details");
    const runningData = await getRunning.json();
    assert(runningData.deployment.serving === true, "Deployment marked as currently serving traffic");
    assert(runningData.deployment.duration === "48s", "Deployment duration formatted properly");

    // Verify parent project status updated to Running
    const projectCheck = await fetch(`${baseUrl}/api/projects/${projectId}`, {
      headers: { Cookie: tokenCookieA },
    });
    const projectCheckData = await projectCheck.json();
    assert(projectCheckData.project.status === "RUNNING", "Parent project status synced to Running");

    // 9. Cancel the second deployment
    const cancelRes = await fetch(`${baseUrl}/api/deployments/${deployId2}/cancel`, {
      method: "POST",
      headers: { Cookie: tokenCookieA },
    });
    assert(cancelRes.status === 200, "POST /api/deployments/:id/cancel returns 200");
    const cancelData = await cancelRes.json();
    assert(cancelData.deployment.status === "CANCELLED", "Deployment status set to Cancelled");

    // 10. Cross-tenant isolation: User B cannot access User A's deployments
    const userBEmail = `deploy_user_b_${Date.now()}@test.com`;
    const regResB = await fetch(`${baseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        user_name: "Deployer B",
        email: userBEmail,
        password: "StrongPassword123!",
      }),
    });
    const cookieHeaderB = regResB.headers.get("set-cookie");
    const tokenCookieB = cookieHeaderB ? cookieHeaderB.split(";")[0] : "";

    const userBGet = await fetch(`${baseUrl}/api/deployments/${deployId1}`, {
      headers: { Cookie: tokenCookieB },
    });
    assert(userBGet.status === 404, "User B cannot view User A's deployment (404)");

    const userBPatch = await fetch(`${baseUrl}/api/deployments/${deployId1}/status`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: tokenCookieB },
      body: JSON.stringify({ status: "Failed" }),
    });
    assert(userBPatch.status === 404, "User B cannot alter User A's deployment status (404)");

    const userBCancel = await fetch(`${baseUrl}/api/deployments/${deployId1}/cancel`, {
      method: "POST",
      headers: { Cookie: tokenCookieB },
    });
    assert(userBCancel.status === 404, "User B cannot cancel User A's deployment (404)");

    console.log("==================================================");
    console.log(`  All Deployments tests passed! (${passed}/${passed})`);
    console.log("==================================================");
  } finally {
    server.close();
    try {
      const redis = require("../config/redis.js");
      redis.disconnect();
    } catch (_) {}
    await pool.end();
  }
}

runTestSuite()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Test execution failed:", err);
    process.exit(1);
  });
