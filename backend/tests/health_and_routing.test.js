const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "../.env") });
require("dotenv").config();

const express = require("express");
const cookieParser = require("cookie-parser");
const pool = require("../config/db.js");
const authRoutes = require("../routes/auth.js");
const projectRoutes = require("../routes/projects.js");
const routingRoutes = require("../routes/routing.js");
const { probeContainerEndpoint } = require("../services/healthCheck.js");
const {
  registerUpstreamRoute,
  unregisterUpstreamRoute,
  resolveDomain,
  getRoutingTable,
  generateNginxConfig,
} = require("../services/proxyRouter.js");

function createApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use("/api/auth", authRoutes);
  app.use("/api/projects", projectRoutes);
  app.use("/api/routing", routingRoutes);
  return app;
}

async function runTestSuite() {
  console.log("==================================================");
  console.log("  DeployForge Health Probe & Reverse Proxy Tests  ");
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
    // 1. Unit: Container Health Check Probe
    const probe = await probeContainerEndpoint({ host: "127.0.0.1", port: 3000 });
    assert(probe.healthy === true, "Probe returned healthy container status");
    assert(probe.statusCode === 200, "Probe returned HTTP 200 status code");
    assert(typeof probe.latencyMs === "number", "Probe measured latency in milliseconds");

    // 2. Unit: Upstream Routing Registration & Resolution
    const testDomain = `test-app-${Date.now()}.deployforge.app`;
    registerUpstreamRoute(testDomain, {
      projectId: "proj-123",
      projectName: "test-app",
      deploymentId: "dep-456",
      containerId: "c_dep456",
      targetHost: "127.0.0.1",
      port: 8080,
      status: "Healthy",
    });

    const resolved = resolveDomain(testDomain);
    assert(resolved !== null, "Resolved registered domain successfully");
    assert(resolved.port === 8080, "Resolved route has target container port 8080");
    assert(resolved.container_id === "c_dep456", "Resolved route has container ID");

    // 3. Unit: Nginx Dynamic Configuration Generator
    const nginxConf = generateNginxConfig();
    assert(nginxConf.includes("upstream upstream_df_proj123_8080"), "Nginx config generated upstream block");
    assert(nginxConf.includes(`server_name ${testDomain};`), "Nginx config generated server block for domain");
    assert(nginxConf.includes("proxy_pass http://upstream_df_proj123_8080;"), "Nginx config includes proxy_pass directive");

    // 4. API: Unauthenticated routing endpoints must return 401
    const unauthTableRes = await fetch(`${baseUrl}/api/routing/table`);
    assert(unauthTableRes.status === 401, "GET /api/routing/table without token returns 401 Unauthorized");

    const unauthResolveRes = await fetch(`${baseUrl}/api/routing/resolve/${testDomain}`);
    assert(unauthResolveRes.status === 401, "GET /api/routing/resolve/:domain without token returns 401 Unauthorized");

    const unauthHealthRes = await fetch(`${baseUrl}/api/routing/health/dummy-project-id`);
    assert(unauthHealthRes.status === 401, "GET /api/routing/health without token returns 401 Unauthorized");

    // Register User A
    const userAEmail = `health_user_a_${Date.now()}@test.com`;
    const regResA = await fetch(`${baseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        user_name: "Health Tester",
        email: userAEmail,
        password: "HealthPassword123!",
      }),
    });
    assert(regResA.status === 201, "User A registered successfully");
    const cookieA = regResA.headers.get("set-cookie").split(";")[0];

    // Create a project for User A
    const projRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookieA },
      body: JSON.stringify({
        name: `Health-Demo-${Date.now()}`,
        repository_url: "https://github.com/deployforge/demo-health",
        runtime: "node",
        port: 4000,
      }),
    });
    assert(projRes.status === 201, "Project created successfully");
    const createdProject = (await projRes.json()).project;

    // Register upstream route associated with User A's project
    registerUpstreamRoute(testDomain, {
      projectId: createdProject.id,
      projectName: createdProject.name,
      deploymentId: "dep-456",
      containerId: "c_dep456",
      targetHost: "127.0.0.1",
      port: 8080,
      status: "Healthy",
    });

    // 5. API: Authenticated GET /api/routing/table & resolve for User A
    const tableRes = await fetch(`${baseUrl}/api/routing/table`, {
      headers: { Cookie: cookieA },
    });
    assert(tableRes.status === 200, "Authenticated GET /api/routing/table returns 200 OK");
    const tableData = await tableRes.json();
    assert(tableData.active_routes_count >= 1, "Routing table reports active routes count for owner");
    assert(Array.isArray(tableData.routes), "Routing table contains routes array");
    assert(tableData.nginx_config === undefined, "Routing table does not leak raw nginx_config");

    const resolveRes = await fetch(`${baseUrl}/api/routing/resolve/${testDomain}`, {
      headers: { Cookie: cookieA },
    });
    assert(resolveRes.status === 200, "Authenticated GET /api/routing/resolve/:domain returns 200 OK");
    const resolveData = await resolveRes.json();
    assert(resolveData.matched === true, "Domain resolution API returns matched: true");
    assert(resolveData.target_upstream === "http://127.0.0.1:8080", "Domain resolution API returns target upstream URL");

    const nonExistentRes = await fetch(`${baseUrl}/api/routing/resolve/unknown-never-registered.app`, {
      headers: { Cookie: cookieA },
    });
    assert(nonExistentRes.status === 404, "Unregistered domain returns 404 Not Found");

    // 6. API: Authenticated On-Demand Health Probe (GET /api/routing/health/:projectId)
    const healthCheckRes = await fetch(`${baseUrl}/api/routing/health/${createdProject.id}`, {
      headers: { Cookie: cookieA },
    });
    assert(healthCheckRes.status === 200, "GET /api/routing/health/:projectId returns 200 OK");
    const healthData = await healthCheckRes.json();
    assert(healthData.project_id === createdProject.id, "Health report matches project ID");
    assert(healthData.port === 4000, "Health report probed declared internal port 4000");
    assert(healthData.probe.healthy === true, "Health report confirms container probe healthy");
    assert(typeof healthData.probe.latency_ms === "number", "Health report includes probe latency");

    // Register User B to test tenant isolation
    const userBEmail = `health_user_b_${Date.now()}@test.com`;
    const regResB = await fetch(`${baseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        user_name: "Tenant Spy",
        email: userBEmail,
        password: "HealthPassword123!",
      }),
    });
    assert(regResB.status === 201, "User B registered successfully");
    const cookieB = regResB.headers.get("set-cookie").split(";")[0];

    // User B tries to view User A's routes in /api/routing/table
    const userBTableRes = await fetch(`${baseUrl}/api/routing/table`, {
      headers: { Cookie: cookieB },
    });
    assert(userBTableRes.status === 200, "User B GET /api/routing/table returns 200");
    const userBTableData = await userBTableRes.json();
    const hasUserARoute = userBTableData.routes.some((r) => r.domain === testDomain);
    assert(!hasUserARoute, "User B cannot view User A's route in /api/routing/table");

    // User B tries to resolve User A's domain
    const userBResolveRes = await fetch(`${baseUrl}/api/routing/resolve/${testDomain}`, {
      headers: { Cookie: cookieB },
    });
    assert(userBResolveRes.status === 404, "User B cannot resolve User A's domain (404 Isolated)");

    // User B tries to probe User A's project
    const crossHealthRes = await fetch(`${baseUrl}/api/routing/health/${createdProject.id}`, {
      headers: { Cookie: cookieB },
    });
    assert(crossHealthRes.status === 404, "User B cannot probe User A's project (404 Multi-Tenant Isolated)");

    // 7. Unregister route cleanup
    unregisterUpstreamRoute(testDomain);
    assert(resolveDomain(testDomain) === null, "Unregistered domain resolves to null");

    // 8. DF-10: Serialized Concurrent Ingress Config Sync
    const { syncNginxConfig, UPSTREAMS_CONF_FILE } = require("../services/nginxManager.js");
    const fs = require("fs");
    const concurrentWrites = Array.from({ length: 5 }, (_, i) =>
      syncNginxConfig(`# Auto-generated upstream config batch ${i}\nupstream dummy_${i} { server 127.0.0.1:800${i}; }\n`)
    );
    const syncResults = await Promise.all(concurrentWrites);
    assert(syncResults.every((r) => r.synced === true), "All 5 concurrent Nginx sync operations serialized cleanly");
    assert(fs.existsSync(UPSTREAMS_CONF_FILE), "Active upstreams configuration exists without corrupt partial writes");

    console.log("==================================================");
    console.log(`  All Health & Routing tests passed! (${passed}/${passed})`);
    console.log("==================================================");
  } catch (error) {
    console.error("Test execution failed:", error);
    process.exit(1);
  } finally {
    server.close();
  }
}

runTestSuite()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Fatal test runner error:", err);
    process.exit(1);
  });
