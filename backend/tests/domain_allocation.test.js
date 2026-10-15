const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "../.env") });
require("dotenv").config();

const express = require("express");
const cookieParser = require("cookie-parser");
const pool = require("../config/db.js");
const authRoutes = require("../routes/auth.js");
const projectRoutes = require("../routes/projects.js");
const {
  registerUpstreamRoute,
  unregisterUpstreamRoute,
  generateNginxConfig,
} = require("../services/proxyRouter.js");

function createApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use("/api/auth", authRoutes);
  app.use("/api/projects", projectRoutes);
  return app;
}

describe("S-04: Global Domain Uniqueness, Reserved Slugs, and Collision-Free Upstreams", () => {
  let server;
  let baseUrl;
  let tokenCookieA;
  let tokenCookieB;
  let userAId;
  let userBId;
  let projectAId;
  let projectBId;

  before(async () => {
    const app = createApp();
    server = app.listen(0);
    const port = server.address().port;
    baseUrl = `http://localhost:${port}`;

    // Register User A
    const userAEmail = `domain_user_a_${Date.now()}@test.com`;
    const regResA = await fetch(`${baseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        user_name: "Tenant User A",
        email: userAEmail,
        password: "StrongPassword123!",
      }),
    });
    assert.equal(regResA.status, 201, "Failed to register User A");
    const regDataA = await regResA.json();
    userAId = regDataA.user.id;
    const cookieHeaderA = regResA.headers.get("set-cookie");
    tokenCookieA = cookieHeaderA ? cookieHeaderA.split(";")[0] : "";

    // Register User B
    const userBEmail = `domain_user_b_${Date.now()}@test.com`;
    const regResB = await fetch(`${baseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        user_name: "Tenant User B",
        email: userBEmail,
        password: "StrongPassword123!",
      }),
    });
    assert.equal(regResB.status, 201, "Failed to register User B");
    const regDataB = await regResB.json();
    userBId = regDataB.user.id;
    const cookieHeaderB = regResB.headers.get("set-cookie");
    tokenCookieB = cookieHeaderB ? cookieHeaderB.split(";")[0] : "";
  });

  after(async () => {
    if (server) {
      if (typeof server.closeAllConnections === "function") {
        server.closeAllConnections();
      }
      await new Promise((resolve) => server.close(resolve));
    }

    if (userAId || userBId) {
      try {
        await pool.query("DELETE FROM users WHERE id = $1 OR id = $2", [userAId, userBId]);
      } catch (_) {}
    }

    try {
      const redis = require("../config/redis.js");
      redis.disconnect();
    } catch (_) {}

    try {
      await pool.end();
    } catch (_) {}
  });

  it("Test 1: Creating a project with reserved name (e.g. api, admin, dashboard) returns 400 Bad Request", async () => {
    const reservedNames = ["api", "admin", "dashboard", "status", "health", "auth", "login", "static", "deployforge", "www", "app"];

    for (const reserved of reservedNames) {
      const res = await fetch(`${baseUrl}/api/projects`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: tokenCookieA },
        body: JSON.stringify({
          name: reserved,
          repository_url: "https://github.com/acme/reserved-app",
        }),
      });

      assert.equal(res.status, 400, `POST /api/projects with reserved name '${reserved}' must return 400`);
      const data = await res.json();
      assert.ok(
        data.message.toLowerCase().includes("reserved"),
        `Error message for '${reserved}' should mention reserved status, got: ${data.message}`
      );
    }
  });

  it("Test 2: Two different users creating projects with the same name get distinct domains", async () => {
    const testProjectName = `multi-tenant-service`;

    // Ensure clean state for multi-tenant-service
    await pool.query(
      "DELETE FROM projects WHERE name = $1 OR domain LIKE $2",
      [testProjectName, `${testProjectName}%.deployforge.app`]
    );

    // User A creates multi-tenant-service -> multi-tenant-service.deployforge.app
    const resA = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: tokenCookieA },
      body: JSON.stringify({
        name: testProjectName,
        repository_url: "https://github.com/acme/multi-tenant-service",
        branch: "main",
        runtime: "node",
        port: 3000,
      }),
    });
    assert.equal(resA.status, 201, "User A creates project successfully");
    const dataA = await resA.json();
    assert.equal(dataA.project.domain, "multi-tenant-service.deployforge.app");
    projectAId = dataA.project.id;

    // User B creates multi-tenant-service -> multi-tenant-service-2.deployforge.app
    const resB = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: tokenCookieB },
      body: JSON.stringify({
        name: testProjectName,
        repository_url: "https://github.com/acme/multi-tenant-service",
        branch: "main",
        runtime: "node",
        port: 3000,
      }),
    });
    assert.equal(resB.status, 201, "User B creates project with same name successfully");
    const dataB = await resB.json();
    assert.equal(dataB.project.domain, "multi-tenant-service-2.deployforge.app");
    projectBId = dataB.project.id;

    // Verify both projects exist with unique domains in PostgreSQL
    const dbCheck = await pool.query(
      "SELECT id, user_id, name, domain FROM projects WHERE id IN ($1, $2)",
      [projectAId, projectBId]
    );
    assert.equal(dbCheck.rows.length, 2);
    const domainSet = new Set(dbCheck.rows.map((r) => r.domain));
    assert.equal(domainSet.size, 2, "Both projects must have distinct domains in database");
    assert.ok(domainSet.has("multi-tenant-service.deployforge.app"));
    assert.ok(domainSet.has("multi-tenant-service-2.deployforge.app"));
  });

  it("Test 3: Renaming User A's project reallocates domain uniquely and handles collisions", async () => {
    // Attempting to rename to a reserved slug must return 400 Bad Request
    const patchReserved = await fetch(`${baseUrl}/api/projects/${projectAId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: tokenCookieA },
      body: JSON.stringify({ name: "admin" }),
    });
    assert.equal(patchReserved.status, 400, "Renaming project to reserved name returns 400");
    const resData = await patchReserved.json();
    assert.ok(resData.message.toLowerCase().includes("reserved"));

    // User B creates another project 'shared-tool' -> shared-tool.deployforge.app
    const resShared = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: tokenCookieB },
      body: JSON.stringify({
        name: "shared-tool",
        repository_url: "https://github.com/acme/shared-tool",
        branch: "main",
      }),
    });
    assert.equal(resShared.status, 201);
    const sharedData = await resShared.json();
    assert.equal(sharedData.project.domain, "shared-tool.deployforge.app");

    // User A renames their project to 'shared-tool' -> User A should get 'shared-tool-2.deployforge.app'
    const patchCollision = await fetch(`${baseUrl}/api/projects/${projectAId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: tokenCookieA },
      body: JSON.stringify({ name: "shared-tool" }),
    });
    assert.equal(patchCollision.status, 200, "Renaming to name taken by another tenant succeeds with suffixed domain");
    const patchData = await patchCollision.json();
    assert.equal(patchData.project.name, "shared-tool");
    assert.equal(patchData.project.domain, "shared-tool-2.deployforge.app");

    // Re-saving without changing name preserves the allocated domain
    const patchSame = await fetch(`${baseUrl}/api/projects/${projectAId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: tokenCookieA },
      body: JSON.stringify({ name: "shared-tool", port: 8080 }),
    });
    assert.equal(patchSame.status, 200);
    const sameData = await patchSame.json();
    assert.equal(sameData.project.domain, "shared-tool-2.deployforge.app");
  });

  it("Test 4: generateNginxConfig() generates collision-free upstream names (upstream_df_...) even when two routes have the same project name and port", () => {
    const routeADomain = "tenant-a-service.deployforge.app";
    const routeBDomain = "tenant-b-service.deployforge.app";

    try {
      registerUpstreamRoute(routeADomain, {
        projectId: "proj-1111-aaaa",
        projectName: "shared-upstream-app",
        deploymentId: "dep-a",
        containerId: "c_a",
        targetHost: "127.0.0.1",
        port: 3000,
        status: "Healthy",
      });

      registerUpstreamRoute(routeBDomain, {
        projectId: "proj-2222-bbbb",
        projectName: "shared-upstream-app",
        deploymentId: "dep-b",
        containerId: "c_b",
        targetHost: "127.0.0.1",
        port: 3000,
        status: "Healthy",
      });

      const nginxConfig = generateNginxConfig();

      // Expected upstream names hashed by project ID short hash
      const expectedUpstreamA = "upstream_df_proj1111aaaa_3000";
      const expectedUpstreamB = "upstream_df_proj2222bbbb_3000";

      assert.ok(
        nginxConfig.includes(`upstream ${expectedUpstreamA} {`),
        `Config must contain upstream block ${expectedUpstreamA}`
      );
      assert.ok(
        nginxConfig.includes(`upstream ${expectedUpstreamB} {`),
        `Config must contain upstream block ${expectedUpstreamB}`
      );
      assert.notEqual(expectedUpstreamA, expectedUpstreamB, "Upstream names must be distinct");

      // Verify proxy_pass blocks match their respective upstreams
      assert.ok(
        nginxConfig.includes(`proxy_pass http://${expectedUpstreamA};`),
        `Config must proxy_pass to ${expectedUpstreamA}`
      );
      assert.ok(
        nginxConfig.includes(`proxy_pass http://${expectedUpstreamB};`),
        `Config must proxy_pass to ${expectedUpstreamB}`
      );

      // Verify old name-based upstream is NOT generated
      assert.ok(
        !nginxConfig.includes("upstream_shared_upstream_app_3000"),
        "Config should not generate colliding upstream based on project name"
      );
    } finally {
      unregisterUpstreamRoute(routeADomain);
      unregisterUpstreamRoute(routeBDomain);
    }
  });
});
