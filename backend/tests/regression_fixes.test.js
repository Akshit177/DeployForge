/**
 * Regression tests for the bug-fix review. Each group names the defect it guards against.
 */
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "../.env") });
require("dotenv").config();

const express = require("express");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");
const pool = require("../config/db.js");
const redis = require("../config/redis.js");

const authRoutes = require("../routes/auth.js");
const projectRoutes = require("../routes/projects.js");
const deploymentRoutes = require("../routes/deployments.js");
const logRoutes = require("../routes/logs.js");
const routingRoutes = require("../routes/routing.js");
const internalRoutes = require("../routes/internal.js");

const {
  registerUpstreamRoute,
  unregisterUpstreamRoute,
  resolveDomain,
  getRoutingTable,
  generateNginxConfig,
} = require("../services/proxyRouter.js");
const { escapeHtml } = require("../utils/html.js");
const { isLikelySecret } = require("../utils/validators.js");
const { resolveContainerTarget } = require("../services/dockerClient.js");
const { publishDeploymentEvent } = require("../services/deploymentEvents.js");
const { drainPersistenceEvents } = require("../workers/persistenceWorker.js");

function createApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use("/api/auth", authRoutes);
  app.use("/api/projects", projectRoutes);
  app.use("/api/deployments", deploymentRoutes);
  app.use("/api/logs", logRoutes);
  app.use("/api/routing", routingRoutes);
  app.use("/internal", internalRoutes);
  return app;
}

const uniq = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

describe("Regression fixes", () => {
  let server;
  let baseUrl;
  const sockets = new Set();

  async function api(method, url, { token, cookie, body } = {}) {
    const headers = { "Content-Type": "application/json" };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (cookie) headers.Cookie = cookie;
    const res = await fetch(`${baseUrl}${url}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let json = null;
    try {
      json = await res.json();
    } catch (_) {}
    return { status: res.status, json, headers: res.headers };
  }

  async function registerUser(label) {
    const res = await fetch(`${baseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        user_name: `Regression ${label}`,
        email: `reg_${label}_${uniq()}@test.com`,
        password: "RegressionPass123!",
      }),
    });
    assert.equal(res.status, 201);
    const cookie = res.headers.get("set-cookie").split(";")[0];
    const json = await res.json();
    return { cookie, token: json.token, user: json.user };
  }

  async function createProject(cookie, extra = {}) {
    const res = await api("POST", "/api/projects", {
      cookie,
      body: {
        name: `reg-${uniq()}`.slice(0, 30),
        repository_url: "https://github.com/deployforge/regression-repo",
        branch: "main",
        runtime: "node",
        port: 3000,
        ...extra,
      },
    });
    assert.equal(res.status, 201, JSON.stringify(res.json));
    return res.json.project;
  }

  async function insertDeployment(project, userId, status, containerName = null) {
    const r = await pool.query(
      `INSERT INTO deployments (project_id, user_id, status, container_name)
       VALUES ($1, $2, $3, $4) RETURNING id, container_name`,
      [project.id, userId, status, containerName]
    );
    return r.rows[0];
  }

  before(async () => {
    const app = createApp();
    server = app.listen(0);
    server.on("connection", (s) => {
      sockets.add(s);
      s.once("close", () => sockets.delete(s));
    });
    baseUrl = `http://localhost:${server.address().port}`;
  });

  after(async () => {
    for (const s of sockets) s.destroy();
    if (server) {
      if (typeof server.closeAllConnections === "function") server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    try {
      redis.disconnect();
    } catch (_) {}
    try {
      await pool.end();
    } catch (_) {}
  });

  // ---------------------------------------------------------------------------------------
  describe("Auth: invalid/expired tokens are 401 (the frontend only reacts to 401)", () => {
    it("garbage token -> 401", async () => {
      const r = await api("GET", "/api/auth/me", { token: "not-a-jwt" });
      assert.equal(r.status, 401);
    });

    it("expired token -> 401 with an 'expired' message", async () => {
      const { token } = await registerUser("exp");
      const decoded = jwt.decode(token);
      const expired = jwt.sign({ id: decoded.id, sid: decoded.sid }, process.env.JWT_SECRET, {
        algorithm: "HS256",
        expiresIn: -10,
      });
      const r = await api("GET", "/api/auth/me", { token: expired });
      assert.equal(r.status, 401);
      assert.match(r.json.message, /expired/i);
    });

    it("a token close to expiry is re-issued (sliding session)", async () => {
      const { token } = await registerUser("slide");
      const decoded = jwt.decode(token);
      const nearExpiry = jwt.sign({ id: decoded.id, sid: decoded.sid }, process.env.JWT_SECRET, {
        algorithm: "HS256",
        expiresIn: 60,
      });
      const r = await api("GET", "/api/auth/me", { token: nearExpiry });
      assert.equal(r.status, 200);
      const fresh = r.headers.get("x-auth-token");
      assert.ok(fresh, "expected X-Auth-Token header");
      assert.ok(jwt.decode(fresh).exp - Math.floor(Date.now() / 1000) > 600);
      assert.match(r.headers.get("set-cookie") || "", /token=/);
    });

    it("a fresh token is NOT re-issued", async () => {
      const { token } = await registerUser("noslide");
      const r = await api("GET", "/api/auth/me", { token });
      assert.equal(r.status, 200);
      assert.equal(r.headers.get("x-auth-token"), null);
    });

    it("register rejects a malformed email", async () => {
      const r = await api("POST", "/api/auth/register", {
        body: { user_name: "Bad Email", email: "not-an-email", password: "LongEnough123" },
      });
      assert.equal(r.status, 400);
    });
  });

  // ---------------------------------------------------------------------------------------
  describe("Sessions: logout is honoured via Bearer and on /api/logs", () => {
    it("Bearer-only logout revokes the session everywhere", async (t) => {
      if (redis.status !== "ready") return t.skip("Redis not ready");
      const { token, user } = await registerUser("logout");
      const project = await createProject(`token=${token}`);

      // /api/logs accepts a Bearer header (it used to be cookie/query only)
      const ok = await api("GET", `/api/logs?project_id=${project.id}`, { token });
      assert.equal(ok.status, 200);

      const out = await api("POST", "/api/auth/logout", { token });
      assert.equal(out.status, 200);

      const me = await api("GET", "/api/auth/me", { token });
      assert.equal(me.status, 401, "/me must reject a revoked session");

      const logs = await api("GET", `/api/logs?project_id=${project.id}`, { token });
      assert.equal(logs.status, 401, "/api/logs must reject a revoked session");
      assert.ok(user.id);
    });
  });

  // ---------------------------------------------------------------------------------------
  describe("Routing PUT: tenants cannot hijack routes or choose upstream hosts", () => {
    let alice;
    let mallory;
    let project;
    let dep;

    before(async () => {
      alice = await registerUser("alice");
      mallory = await registerUser("mallory");
      project = await createProject(alice.cookie);
      dep = await insertDeployment(project, alice.user.id, "RUNNING", "df-aaaaaaaaaaaa");
    });

    it("rejects another user's attempt to point the domain at their host", async () => {
      const r = await api("PUT", `/api/routing/${project.domain}`, {
        cookie: mallory.cookie,
        body: { target_host: "evil.internal", port: 80, project_id: "x" },
      });
      assert.equal(r.status, 404);
      const hit = resolveDomain(project.domain);
      assert.ok(!hit || hit.target_host !== "evil.internal");
    });

    it("owner cannot choose target_host; it is derived from the running deployment", async () => {
      const r = await api("PUT", `/api/routing/${project.domain}`, {
        cookie: alice.cookie,
        body: { target_host: "postgres", port: 3000 },
      });
      assert.equal(r.status, 200);
      assert.equal(r.json.route.target_host, "df-aaaaaaaaaaaa");
      assert.equal(r.json.route.deployment_id, dep.id);
    });

    it("owner gets 409 when nothing is running", async () => {
      const p2 = await createProject(alice.cookie);
      const r = await api("PUT", `/api/routing/${p2.domain}`, { cookie: alice.cookie, body: {} });
      assert.equal(r.status, 409);
    });

    it("rejects an invalid port override", async () => {
      const r = await api("PUT", `/api/routing/${project.domain}`, {
        cookie: alice.cookie,
        body: { port: 99999 },
      });
      assert.equal(r.status, 400);
    });
  });

  // ---------------------------------------------------------------------------------------
  describe("proxyRouter: exact, scoped, validated", () => {
    const tag = uniq();

    it("unregistering a domain does not remove domains that merely contain it", () => {
      registerUpstreamRoute(`shop-${tag}.deployforge.app`, { projectId: "p-shop", projectName: "shop", targetHost: "df-1", port: 3000 });
      registerUpstreamRoute(`bigshop-${tag}.deployforge.app`, { projectId: "p-big", projectName: "bigshop", targetHost: "df-2", port: 3000 });
      registerUpstreamRoute(`my-shop-${tag}.deployforge.app`, { projectId: "p-my", projectName: "my-shop", targetHost: "df-3", port: 3000 });

      unregisterUpstreamRoute(`shop-${tag}.deployforge.app`, { projectId: "p-shop" });

      const domains = getRoutingTable().map((r) => r.domain);
      assert.ok(!domains.includes(`shop-${tag}.deployforge.app`));
      assert.ok(domains.includes(`bigshop-${tag}.deployforge.app`));
      assert.ok(domains.includes(`my-shop-${tag}.deployforge.app`));
    });

    it("project teardown does not remove another tenant's route with the same project name", () => {
      registerUpstreamRoute(`blog-${tag}.deployforge.app`, { projectId: "p-a", projectName: "blog", targetHost: "df-a", port: 3000 });
      registerUpstreamRoute(`blog-${tag}-2.deployforge.app`, { projectId: "p-b", projectName: "blog", targetHost: "df-b", port: 3000 });

      unregisterUpstreamRoute(`blog-${tag}-2.deployforge.app`, { projectId: "p-b", projectName: "blog" });

      const domains = getRoutingTable().map((r) => r.domain);
      assert.ok(domains.includes(`blog-${tag}.deployforge.app`));
      assert.ok(!domains.includes(`blog-${tag}-2.deployforge.app`));
    });

    it("a stopped/cancelled deployment cannot unroute a different, live deployment", () => {
      const domain = `live-${tag}.deployforge.app`;
      registerUpstreamRoute(domain, { projectId: "p-l", projectName: "live", deploymentId: "dep-live", targetHost: "df-live", port: 3000 });

      const removed = unregisterUpstreamRoute(domain, { projectId: "p-l", deploymentId: "dep-old-or-pending" });
      assert.equal(removed, false);
      assert.ok(resolveDomain(domain));

      assert.equal(unregisterUpstreamRoute(domain, { projectId: "p-l", deploymentId: "dep-live" }), true);
      assert.equal(resolveDomain(domain), null);
    });

    it("the unique domain prefix wins over a duplicate project-name alias", () => {
      // Tenant B registered first and also has a project named "dup"
      registerUpstreamRoute(`dup-${tag}-2.deployforge.app`, { projectId: "p-2", projectName: `dup-${tag}`, targetHost: "df-b", port: 3000 });
      registerUpstreamRoute(`dup-${tag}.deployforge.app`, { projectId: "p-1", projectName: `dup-${tag}`, targetHost: "df-a", port: 3000 });

      const hit = resolveDomain(`dup-${tag}.localhost`);
      assert.equal(hit.project_id, "p-1");
    });

    it("rejects unsafe hosts/domains and never writes them into nginx config", () => {
      assert.equal(
        registerUpstreamRoute(`inj-${tag}.deployforge.app`, {
          projectId: "p-i",
          targetHost: "x; } server { listen 80; root /; autoindex on; } upstream y { server z",
          port: 3000,
        }),
        null
      );
      assert.equal(registerUpstreamRoute("bad domain;.app", { targetHost: "df-1", port: 3000 }), null);
      assert.equal(registerUpstreamRoute(`port-${tag}.deployforge.app`, { targetHost: "df-1", port: 70000 }), null);

      const conf = generateNginxConfig();
      assert.ok(!conf.includes("autoindex"));
      assert.ok(!conf.includes("inj-"));
    });
  });

  // ---------------------------------------------------------------------------------------
  describe("Events: a failed redeploy does not take the live app down; new deploy supersedes old", () => {
    let owner;
    let project;

    before(async () => {
      owner = await registerUser("events");
      project = await createProject(owner.cookie);
    });

    it("DEPLOYMENT_FAILED for deployment #2 keeps deployment #1's route and project status", async (t) => {
      if (redis.status !== "ready") return t.skip("Redis not ready");
      const live = await insertDeployment(project, owner.user.id, "RUNNING", "df-live00000001");
      await pool.query("UPDATE projects SET status = 'RUNNING' WHERE id = $1", [project.id]);
      registerUpstreamRoute(project.domain, {
        projectId: project.id,
        projectName: project.name,
        deploymentId: live.id,
        containerName: "df-live00000001",
        targetHost: "df-live00000001",
        port: 3000,
      });

      const next = await insertDeployment(project, owner.user.id, "BUILDING");
      await publishDeploymentEvent("DEPLOYMENT_FAILED", {
        deployment_id: next.id,
        project_id: project.id,
        user_id: owner.user.id,
        status: "FAILED",
        domain: project.domain,
        error_message: "build exploded",
      });
      await drainPersistenceEvents();

      const failed = await pool.query("SELECT status FROM deployments WHERE id = $1", [next.id]);
      assert.equal(failed.rows[0].status, "FAILED");
      const proj = await pool.query("SELECT status FROM projects WHERE id = $1", [project.id]);
      assert.equal(proj.rows[0].status, "RUNNING");
      const route = resolveDomain(project.domain);
      assert.ok(route, "live route must survive a failed redeploy");
      assert.equal(route.deployment_id, live.id);
    });

    it("DEPLOYMENT_COMPLETED for a new deployment marks the previous RUNNING one STOPPED", async (t) => {
      if (redis.status !== "ready") return t.skip("Redis not ready");
      const p2 = await createProject(owner.cookie);
      const oldDep = await insertDeployment(p2, owner.user.id, "RUNNING", "df-old000000001");
      const newDep = await insertDeployment(p2, owner.user.id, "STARTING", "df-new000000001");

      await publishDeploymentEvent("DEPLOYMENT_COMPLETED", {
        deployment_id: newDep.id,
        project_id: p2.id,
        user_id: owner.user.id,
        status: "RUNNING",
        container_id: "c_newnewnewnew",
        container_name: "df-new000000001",
        domain: p2.domain,
        port: 3000,
        project_name: p2.name,
      });
      await drainPersistenceEvents();

      const rows = await pool.query("SELECT id, status FROM deployments WHERE project_id = $1", [p2.id]);
      const byId = Object.fromEntries(rows.rows.map((r) => [r.id, r.status]));
      assert.equal(byId[newDep.id], "RUNNING");
      assert.equal(byId[oldDep.id], "STOPPED");
      assert.equal(resolveDomain(p2.domain).deployment_id, newDep.id);
    });
  });

  // ---------------------------------------------------------------------------------------
  describe("Deployments API: JSON null is not persisted as the string 'null'", () => {
    it("null commit_hash / environment / trigger fall back to defaults", async () => {
      const owner = await registerUser("nulls");
      const project = await createProject(owner.cookie);
      const r = await api("POST", "/api/deployments", {
        cookie: owner.cookie,
        body: { project_id: project.id, commit_hash: null, environment: null, trigger: null },
      });
      assert.equal(r.status, 201, JSON.stringify(r.json));
      const row = await pool.query("SELECT commit_hash, environment, trigger FROM deployments WHERE id = $1", [
        r.json.deployment.id,
      ]);
      assert.equal(row.rows[0].commit_hash, "HEAD");
      assert.equal(row.rows[0].environment, "production");
      assert.equal(row.rows[0].trigger, "manual");
    });
  });

  // ---------------------------------------------------------------------------------------
  describe("Projects API", () => {
    it("secret-looking env vars supplied at creation are stored as secrets", async () => {
      const owner = await registerUser("secrets");
      const project = await createProject(owner.cookie, {
        env_vars: [
          { key: "DATABASE_PASSWORD", value: "hunter2" },
          { key: "LOG_LEVEL", value: "debug" },
        ],
      });
      const rows = await pool.query("SELECT key, is_secret FROM project_env_vars WHERE project_id = $1", [project.id]);
      const map = Object.fromEntries(rows.rows.map((r) => [r.key, r.is_secret]));
      assert.equal(map.DATABASE_PASSWORD, true);
      assert.equal(map.LOG_LEVEL, false);
    });

    it("a null entry in env_vars is a 400, not a 500", async () => {
      const owner = await registerUser("nullenv");
      const r = await api("POST", "/api/projects", {
        cookie: owner.cookie,
        body: {
          name: `nullenv-${uniq()}`.slice(0, 30),
          repository_url: "https://github.com/deployforge/regression-repo",
          env_vars: [null],
        },
      });
      assert.equal(r.status, 400);
    });

    it("project names must start with an alphanumeric (worker slug rule) and fit a DNS label", async () => {
      const owner = await registerUser("names");
      const tooLong = await api("POST", "/api/projects", {
        cookie: owner.cookie,
        body: { name: "a".repeat(64), repository_url: "https://github.com/deployforge/regression-repo" },
      });
      assert.equal(tooLong.status, 400);

      const leading = await api("POST", "/api/projects", {
        cookie: owner.cookie,
        body: { name: `_lead${uniq()}`, repository_url: "https://github.com/deployforge/regression-repo" },
      });
      assert.equal(leading.status, 201);
      assert.match(leading.json.project.name, /^[a-z0-9]/);
    });

    it("renaming a project moves its live route to the new domain", async () => {
      const owner = await registerUser("rename");
      const project = await createProject(owner.cookie);
      const dep = await insertDeployment(project, owner.user.id, "RUNNING", "df-rename000001");
      registerUpstreamRoute(project.domain, {
        projectId: project.id,
        projectName: project.name,
        deploymentId: dep.id,
        containerName: "df-rename000001",
        targetHost: "df-rename000001",
        port: 3000,
      });

      const newName = `renamed-${uniq()}`.slice(0, 30);
      const r = await api("PATCH", `/api/projects/${project.id}`, { cookie: owner.cookie, body: { name: newName } });
      assert.equal(r.status, 200, JSON.stringify(r.json));

      assert.equal(resolveDomain(project.domain), null, "old domain must be unrouted");
      const moved = resolveDomain(r.json.project.domain);
      assert.ok(moved, "new domain must be routed");
      assert.equal(moved.deployment_id, dep.id);
    });
  });

  // ---------------------------------------------------------------------------------------
  describe("Internal API token", () => {
    const saved = { NODE_ENV: process.env.NODE_ENV, INTERNAL_TOKEN: process.env.INTERNAL_TOKEN };
    const unknownId = "00000000-0000-4000-8000-000000000000";

    after(() => {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    });

    async function internal(token) {
      const res = await fetch(`${baseUrl}/internal/deployments/${unknownId}/env`, {
        headers: token ? { "X-Internal-Token": token } : {},
      });
      return res.status;
    }

    it("production without INTERNAL_TOKEN disables the endpoint (no public default)", async () => {
      process.env.NODE_ENV = "production";
      delete process.env.INTERNAL_TOKEN;
      assert.equal(await internal("deployforge-internal-dev-token"), 503);
    });

    it("production with INTERNAL_TOKEN rejects the dev default and accepts the configured one", async () => {
      process.env.NODE_ENV = "production";
      process.env.INTERNAL_TOKEN = "a-long-random-internal-token-1234";
      assert.equal(await internal("deployforge-internal-dev-token"), 401);
      assert.equal(await internal(undefined), 401);
      assert.equal(await internal("a-long-random-internal-token-1234"), 404); // authenticated; unknown id
    });
  });

  // ---------------------------------------------------------------------------------------
  describe("Helpers", () => {
    it("escapeHtml neutralises markup", () => {
      assert.equal(escapeHtml(`<img src=x onerror="a('b')">&`), "&lt;img src=x onerror=&quot;a(&#39;b&#39;)&quot;&gt;&amp;");
      assert.equal(escapeHtml(null), "");
    });

    it("isLikelySecret: explicit flag wins, otherwise inferred from the key", () => {
      assert.equal(isLikelySecret("DB_PASSWORD"), true);
      assert.equal(isLikelySecret("LOG_LEVEL"), false);
      assert.equal(isLikelySecret("DB_PASSWORD", false), false);
      assert.equal(isLikelySecret("LOG_LEVEL", true), true);
    });

    it("resolveContainerTarget prefers the Docker-valid container name over the display id", () => {
      assert.equal(resolveContainerTarget({ container_id: "c_abcdef123456", container_name: "df-abcdef123456" }), "df-abcdef123456");
      assert.equal(
        resolveContainerTarget({ container_id: "c_x", id: "11111111-2222-4333-8444-555555555555" }),
        "df-111111112222"
      );
      assert.equal(resolveContainerTarget({}), null);
    });
  });
});
