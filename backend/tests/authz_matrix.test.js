const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
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

const { setDeploymentHotState } = require("../services/hotState.js");
const { registerUpstreamRoute } = require("../services/proxyRouter.js");

function createApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());

  const routers = [
    { prefix: "/api/auth", router: authRoutes },
    { prefix: "/api/projects", router: projectRoutes },
    { prefix: "/api/deployments", router: deploymentRoutes },
    { prefix: "/api/logs", router: logRoutes },
    { prefix: "/api/settings", router: settingsRoutes },
    { prefix: "/api/routing", router: routingRoutes },
  ];

  for (const { prefix, router } of routers) {
    router._mountPrefix = prefix;
    app.use(prefix, router);
  }

  return app;
}

/**
 * Automatically enumerate all routes from Express router hierarchy
 * Produces a list of { method, path } tuples across the entire application.
 */
function enumerateRoutes(app) {
  const routes = [];
  const seen = new Set();
  const stack = (app.router || app._router)?.stack || [];

  function walk(prefix, router) {
    const s = router.stack || [];
    for (const layer of s) {
      if (layer.route) {
        const methods = Object.keys(layer.route.methods).map((m) => m.toUpperCase());
        for (const method of methods) {
          const fullPath = (prefix + (layer.route.path === "/" ? "" : layer.route.path)).replace(/\/+/g, "/");
          const key = `${method} ${fullPath}`;
          if (!seen.has(key)) {
            seen.add(key);
            routes.push({ method, path: fullPath });
          }
        }
      } else if (layer.handle && layer.handle.stack) {
        let subPrefix = "";
        if (layer.matchers?.[0]?.("/__TEST_ID__/env")) {
          subPrefix = "/:id/env";
        } else if (layer.handle._mountPrefix) {
          subPrefix = layer.handle._mountPrefix;
        }
        walk((prefix + subPrefix).replace(/\/+/g, "/"), layer.handle);
      }
    }
  }

  for (const layer of stack) {
    if (layer.handle && layer.handle.stack) {
      const prefix = layer.handle._mountPrefix || "";
      walk(prefix, layer.handle);
    } else if (layer.route) {
      walk("", { stack: [layer] });
    }
  }

  return routes;
}

describe("T-02: Comprehensive Authorization Matrix Test Suite", () => {
  let server;
  let baseUrl;
  let cookieA; // User A (Owner)
  let cookieB; // User B (Attacker / Other Tenant)
  let userA;
  let userB;
  let projectA;
  let deploymentA;
  let customDomainName;
  let enumeratedRoutes = [];

  const publicRoutes = new Set([
    "POST /api/auth/register",
    "POST /api/auth/login",
    "POST /api/auth/logout",
  ]);

  const activeSockets = new Set();

  before(async () => {
    const app = createApp();
    enumeratedRoutes = enumerateRoutes(app);
    server = app.listen(0);
    server.on("connection", (s) => {
      activeSockets.add(s);
      s.once("close", () => activeSockets.delete(s));
    });
    const port = server.address().port;
    baseUrl = `http://localhost:${port}`;

    // 1. Register User A (Owner)
    const emailA = `owner_${Date.now()}@test.com`;
    const regResA = await fetch(`${baseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        user_name: "Owner User A",
        email: emailA,
        password: "OwnerPassword123!",
      }),
    });
    assert.equal(regResA.status, 201, "Failed to register User A");
    cookieA = regResA.headers.get("set-cookie").split(";")[0];
    userA = (await regResA.json()).user;

    // 2. Register User B (Attacker / Different Tenant)
    const emailB = `attacker_${Date.now()}@test.com`;
    const regResB = await fetch(`${baseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        user_name: "Attacker User B",
        email: emailB,
        password: "AttackerPassword123!",
      }),
    });
    assert.equal(regResB.status, 201, "Failed to register User B");
    cookieB = regResB.headers.get("set-cookie").split(";")[0];
    userB = (await regResB.json()).user;

    // 3. User A creates a project
    const projRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookieA },
      body: JSON.stringify({
        name: `authz-proj-${Date.now() % 10000}`,
        repository_url: "https://github.com/deployforge/authz-test-repo",
        branch: "main",
        runtime: "node",
        port: 3000,
      }),
    });
    assert.equal(projRes.status, 201, "Failed to create User A project");
    projectA = (await projRes.json()).project;

    // 4. User A creates a manual deployment
    const depRes = await fetch(`${baseUrl}/api/deployments`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookieA },
      body: JSON.stringify({
        project_id: projectA.id,
        commit_message: "AuthZ matrix test commit",
        branch: "main",
      }),
    });
    assert.equal(depRes.status, 201, "Failed to create User A deployment");
    deploymentA = (await depRes.json()).deployment;

    // Initialize hot state for deploymentA so live queries succeed
    await setDeploymentHotState(deploymentA.id, {
      project_id: projectA.id,
      status: "RUNNING",
      stage: "running",
      progress_pct: 100,
      container_id: "c_authz_test_container",
      domain: projectA.domain,
    });

    // 5. User A stores secrets in vault
    const envRes = await fetch(`${baseUrl}/api/projects/${projectA.id}/env`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookieA },
      body: JSON.stringify({
        variables: [
          { key: "API_KEY", value: "super-secret-key-12345", is_secret: true },
          { key: "APP_ENV", value: "staging", is_secret: false },
        ],
      }),
    });
    assert.equal(envRes.status, 201, "Failed to store User A secrets");

    // 6. User A registers custom domain
    customDomainName = `custom-${Date.now() % 10000}.deployforge.test`;
    const domRes = await fetch(`${baseUrl}/api/settings/domains`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookieA },
      body: JSON.stringify({
        domain: customDomainName,
        project_id: projectA.id,
      }),
    });
    assert.equal(domRes.status, 201, "Failed to register User A custom domain");

    // 7. Register upstream route for User A's project
    registerUpstreamRoute(projectA.domain, {
      projectId: projectA.id,
      projectName: projectA.name,
      deploymentId: deploymentA.id,
      containerId: "c_authz_test_container",
      targetHost: "127.0.0.1",
      port: 3000,
      status: "Healthy",
    });
  });

  after(async () => {
    for (const socket of activeSockets) {
      try {
        socket.destroy();
      } catch (_) {}
    }
    activeSockets.clear();
    if (server) {
      if (typeof server.closeAllConnections === "function") {
        server.closeAllConnections();
      }
      await new Promise((resolve) => server.close(resolve));
    }
    try {
      redis.disconnect();
    } catch (_) {}
    try {
      await pool.end();
    } catch (_) {}
  });

  describe("1. Auto-Enumeration & Route Discovery Coverage", () => {
    it("discovers all API routes across routers and nested sub-routers", () => {
      assert.ok(enumeratedRoutes.length >= 30, `Expected >= 30 routes, found ${enumeratedRoutes.length}`);
      // Ensure key resource routes are discovered
      const paths = enumeratedRoutes.map((r) => `${r.method} ${r.path}`);
      assert.ok(paths.includes("GET /api/projects/:id"));
      assert.ok(paths.includes("GET /api/projects/:id/env"));
      assert.ok(paths.includes("GET /api/deployments/:id/live"));
      assert.ok(paths.includes("GET /api/logs/stream"));
      assert.ok(paths.includes("GET /api/routing/resolve/:domain"));
    });
  });

  describe("2. Anonymous Access Control (Anonymous -> 401 or Public)", () => {
    it("permits public routes without authentication", async () => {
      // Logout endpoint is public (clears cookie)
      const res = await fetch(`${baseUrl}/api/auth/logout`, { method: "POST" });
      assert.equal(res.status, 200, "Logout should be publicly accessible");
    });

    it("enforces HTTP 401 Unauthorized across all protected routes", async () => {
      // Sample concrete endpoints for each router to verify anonymous 401
      const endpointsToTest = [
        { method: "GET", path: "/api/auth/me" },
        { method: "GET", path: "/api/projects" },
        { method: "POST", path: "/api/projects", body: {} },
        { method: "GET", path: `/api/projects/${projectA.id}` },
        { method: "PATCH", path: `/api/projects/${projectA.id}`, body: {} },
        { method: "DELETE", path: `/api/projects/${projectA.id}` },
        { method: "GET", path: `/api/projects/${projectA.id}/env` },
        { method: "POST", path: `/api/projects/${projectA.id}/env`, body: { variables: [] } },
        { method: "DELETE", path: `/api/projects/${projectA.id}/env/API_KEY` },
        { method: "GET", path: "/api/deployments/queue/status" },
        { method: "GET", path: "/api/deployments" },
        { method: "POST", path: "/api/deployments", body: {} },
        { method: "GET", path: `/api/deployments/${deploymentA.id}` },
        { method: "GET", path: `/api/deployments/${deploymentA.id}/live` },
        { method: "POST", path: `/api/deployments/${deploymentA.id}/cancel` },
        { method: "POST", path: `/api/deployments/${deploymentA.id}/stop` },
        { method: "GET", path: "/api/logs" },
        { method: "GET", path: `/api/logs/stream?deployment_id=${deploymentA.id}` },
        { method: "POST", path: "/api/logs", body: {} },
        { method: "GET", path: "/api/settings" },
        { method: "PUT", path: "/api/settings/profile", body: {} },
        { method: "PUT", path: "/api/settings/password", body: {} },
        { method: "PUT", path: "/api/settings/notifications", body: {} },
        { method: "GET", path: "/api/settings/domains" },
        { method: "POST", path: "/api/settings/domains", body: {} },
        { method: "DELETE", path: `/api/settings/domains/${customDomainName}` },
        { method: "GET", path: "/api/routing/table" },
        { method: "GET", path: `/api/routing/resolve/${projectA.domain}` },
        { method: "GET", path: `/api/routing/health/${projectA.id}` },
        { method: "PUT", path: `/api/routing/${projectA.domain}`, body: {} },
      ];

      for (const ep of endpointsToTest) {
        const url = `${baseUrl}${ep.path}`;
        const options = {
          method: ep.method,
          headers: ep.body ? { "Content-Type": "application/json" } : {},
          body: ep.body ? JSON.stringify(ep.body) : undefined,
        };

        const res = await fetch(url, options);
        assert.equal(
          res.status,
          401,
          `Expected anonymous access to ${ep.method} ${ep.path} to return 401, got ${res.status}`
        );
      }
    });
  });

  describe("3. Cross-Tenant IDOR Matrix (User B targeting User A resources -> 404)", () => {
    it("GET /api/projects/:id -> 404 for non-owner", async () => {
      const res = await fetch(`${baseUrl}/api/projects/${projectA.id}`, {
        headers: { Cookie: cookieB },
      });
      assert.equal(res.status, 404);
    });

    it("PATCH /api/projects/:id -> 404 for non-owner", async () => {
      const res = await fetch(`${baseUrl}/api/projects/${projectA.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Cookie: cookieB },
        body: JSON.stringify({ name: "hacked-project-name" }),
      });
      assert.equal(res.status, 404);
    });

    it("DELETE /api/projects/:id -> 404 for non-owner", async () => {
      const res = await fetch(`${baseUrl}/api/projects/${projectA.id}`, {
        method: "DELETE",
        headers: { Cookie: cookieB },
      });
      assert.equal(res.status, 404);
    });

    it("GET /api/projects/:id/env -> 404 for non-owner", async () => {
      const res = await fetch(`${baseUrl}/api/projects/${projectA.id}/env`, {
        headers: { Cookie: cookieB },
      });
      assert.equal(res.status, 404);
    });

    it("POST /api/projects/:id/env -> 404 for non-owner", async () => {
      const res = await fetch(`${baseUrl}/api/projects/${projectA.id}/env`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookieB },
        body: JSON.stringify({
          variables: [{ key: "INJECTED", value: "malicious" }],
        }),
      });
      assert.equal(res.status, 404);
    });

    it("DELETE /api/projects/:id/env/:key -> 404 for non-owner", async () => {
      const res = await fetch(`${baseUrl}/api/projects/${projectA.id}/env/API_KEY`, {
        method: "DELETE",
        headers: { Cookie: cookieB },
      });
      assert.equal(res.status, 404);
    });

    it("GET /api/deployments/:id -> 404 for non-owner", async () => {
      const res = await fetch(`${baseUrl}/api/deployments/${deploymentA.id}`, {
        headers: { Cookie: cookieB },
      });
      assert.equal(res.status, 404);
    });

    it("GET /api/deployments/:id/live -> 404 for non-owner (prevents hot state IDOR)", async () => {
      const res = await fetch(`${baseUrl}/api/deployments/${deploymentA.id}/live`, {
        headers: { Cookie: cookieB },
      });
      assert.equal(res.status, 404);
    });

    it("POST /api/deployments/:id/cancel -> 404 for non-owner", async () => {
      const res = await fetch(`${baseUrl}/api/deployments/${deploymentA.id}/cancel`, {
        method: "POST",
        headers: { Cookie: cookieB },
      });
      assert.equal(res.status, 404);
    });

    it("POST /api/deployments/:id/stop -> 404 for non-owner", async () => {
      const res = await fetch(`${baseUrl}/api/deployments/${deploymentA.id}/stop`, {
        method: "POST",
        headers: { Cookie: cookieB },
      });
      assert.equal(res.status, 404);
    });

    it("POST /api/logs -> 404 when injecting logs into other tenant's deployment", async () => {
      const res = await fetch(`${baseUrl}/api/logs`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookieB },
        body: JSON.stringify({
          deployment_id: deploymentA.id,
          project_id: projectA.id,
          level: "INFO",
          source: "attacker",
          message: "Forged log entry from User B",
        }),
      });
      assert.equal(res.status, 404);
    });

    it("GET /api/logs/stream?deployment_id=... -> 404 for non-owner", async () => {
      const res = await fetch(`${baseUrl}/api/logs/stream?deployment_id=${deploymentA.id}`, {
        headers: { Cookie: cookieB },
      });
      assert.equal(res.status, 404);
    });

    it("GET /api/logs/stream?project_id=... -> 404 for non-owner", async () => {
      const res = await fetch(`${baseUrl}/api/logs/stream?project_id=${projectA.id}`, {
        headers: { Cookie: cookieB },
      });
      assert.equal(res.status, 404);
    });

    it("GET /api/routing/resolve/:domain -> 404 for non-owner", async () => {
      const res = await fetch(`${baseUrl}/api/routing/resolve/${projectA.domain}`, {
        headers: { Cookie: cookieB },
      });
      assert.equal(res.status, 404);
    });

    it("GET /api/routing/health/:projectId -> 404 for non-owner", async () => {
      const res = await fetch(`${baseUrl}/api/routing/health/${projectA.id}`, {
        headers: { Cookie: cookieB },
      });
      assert.equal(res.status, 404);
    });

    it("DELETE /api/settings/domains/:id -> 404 when deleting other tenant's domain", async () => {
      const res = await fetch(`${baseUrl}/api/settings/domains/${customDomainName}`, {
        method: "DELETE",
        headers: { Cookie: cookieB },
      });
      assert.equal(res.status, 404);
    });
  });

  describe("4. Owner Access Matrix (User A accessing own resources -> 2xx)", () => {
    it("GET /api/auth/me -> 200 for authenticated user", async () => {
      const res = await fetch(`${baseUrl}/api/auth/me`, {
        headers: { Cookie: cookieA },
      });
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.user.id, userA.id);
    });

    it("GET /api/projects/:id -> 200 for owner", async () => {
      const res = await fetch(`${baseUrl}/api/projects/${projectA.id}`, {
        headers: { Cookie: cookieA },
      });
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.project.id, projectA.id);
    });

    it("GET /api/projects/:id/env -> 200 for owner", async () => {
      const res = await fetch(`${baseUrl}/api/projects/${projectA.id}/env`, {
        headers: { Cookie: cookieA },
      });
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.ok(data.env_vars.some((v) => v.key === "API_KEY"));
    });

    it("GET /api/deployments/:id -> 200 for owner", async () => {
      const res = await fetch(`${baseUrl}/api/deployments/${deploymentA.id}`, {
        headers: { Cookie: cookieA },
      });
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.deployment.id, deploymentA.id);
    });

    it("GET /api/deployments/:id/live -> 200 for owner", async () => {
      const res = await fetch(`${baseUrl}/api/deployments/${deploymentA.id}/live`, {
        headers: { Cookie: cookieA },
      });
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.live, true);
    });

    it("POST /api/logs -> 201 for owner", async () => {
      const res = await fetch(`${baseUrl}/api/logs`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookieA },
        body: JSON.stringify({
          deployment_id: deploymentA.id,
          project_id: projectA.id,
          level: "INFO",
          source: "owner",
          message: "Legitimate owner log entry",
        }),
      });
      assert.equal(res.status, 201);
    });

    it("GET /api/logs/stream -> 200 for owner", async () => {
      const ac = new AbortController();
      const res = await fetch(`${baseUrl}/api/logs/stream?deployment_id=${deploymentA.id}`, {
        headers: { Cookie: cookieA },
        signal: ac.signal,
      });
      assert.equal(res.status, 200);
      ac.abort();
      await res.body.cancel().catch(() => {});
    });

    it("GET /api/routing/resolve/:domain -> 200 for owner", async () => {
      const res = await fetch(`${baseUrl}/api/routing/resolve/${projectA.domain}`, {
        headers: { Cookie: cookieA },
      });
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.matched, true);
    });

    it("GET /api/routing/health/:projectId -> 200 for owner", async () => {
      const res = await fetch(`${baseUrl}/api/routing/health/${projectA.id}`, {
        headers: { Cookie: cookieA },
      });
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.project_id, projectA.id);
    });

    it("DELETE /api/projects/:id/env/:key -> 200 for owner", async () => {
      const res = await fetch(`${baseUrl}/api/projects/${projectA.id}/env/API_KEY`, {
        method: "DELETE",
        headers: { Cookie: cookieA },
      });
      assert.equal(res.status, 200);
    });

    it("DELETE /api/settings/domains/:id -> 200 for owner", async () => {
      const res = await fetch(`${baseUrl}/api/settings/domains/${customDomainName}`, {
        method: "DELETE",
        headers: { Cookie: cookieA },
      });
      assert.equal(res.status, 200);
    });

    it("DELETE /api/projects/:id -> 200 for owner", async () => {
      const res = await fetch(`${baseUrl}/api/projects/${projectA.id}`, {
        method: "DELETE",
        headers: { Cookie: cookieA },
      });
      assert.equal(res.status, 200);
    });
  });
});
