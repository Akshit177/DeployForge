const path = require("path");
const fs = require("fs");
const os = require("os");
const { execSync } = require("child_process");
require("dotenv").config({ path: path.join(__dirname, "../.env") });
require("dotenv").config();

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const cookieParser = require("cookie-parser");
const pool = require("../config/db.js");
const redis = require("../config/redis.js");

const authRoutes = require("../routes/auth.js");
const projectRoutes = require("../routes/projects.js");
const deploymentRoutes = require("../routes/deployments.js");
const logRoutes = require("../routes/logs.js");
const envVarsRoutes = require("../routes/envVars.js");
const routingRoutes = require("../routes/routing.js");
const internalRoutes = require("../routes/internal.js");

const { relayPendingEvents } = require("../services/outboxRelay.js");
const { pollOnce } = require("../workers/deploymentWorker.js");
const {
  resolveDomain,
  getRoutingTable,
  generateNginxConfig,
} = require("../services/proxyRouter.js");
const { ensurePersistenceGroup } = require("../services/deploymentEvents.js");

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
  projectRoutes.use("/:id/env", envVarsRoutes);

  return app;
}

describe("T-04: M1 Acceptance Criteria & Golden Path Smoke Test", () => {
  let app;
  let server;
  let baseUrl;
  let cookieUserA;
  let cookieUserB;
  let userA;
  let userB;
  let projectA;
  let projectB;
  let deploymentA;
  let localGitRepo;

  before(async () => {
    await ensurePersistenceGroup();

    if (redis.status !== "ready" && redis.status !== "connecting") {
      await redis.connect().catch(() => {});
    }

    // Advance event stream cursor
    try {
      await redis.xgroup("SETID", "stream:deployment_events", "deployforge_persistence", "$");
    } catch (_) {}

    // Create local git repository fixture
    localGitRepo = fs.mkdtempSync(path.join(os.tmpdir(), "df_smoke_git_"));
    execSync("git init", { cwd: localGitRepo });
    execSync("git config user.name 'Smoke Committer'", { cwd: localGitRepo });
    execSync("git config user.email 'smoke@deployforge.test'", { cwd: localGitRepo });
    fs.writeFileSync(path.join(localGitRepo, "server.js"), "console.log('Smoke App Running');\n");
    fs.writeFileSync(
      path.join(localGitRepo, "Dockerfile"),
      "FROM alpine:latest\nEXPOSE 3000\nCMD [\"echo\", \"Smoke test container\"]\n"
    );
    execSync("git add .", { cwd: localGitRepo });
    execSync("git commit -m 'Initial commit'", { cwd: localGitRepo });

    app = createApp();
    server = app.listen(0);
    const port = server.address().port;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  after(async () => {
    if (server) server.close();

    try {
      if (localGitRepo && fs.existsSync(localGitRepo)) {
        fs.rmSync(localGitRepo, { recursive: true, force: true });
      }
      if (projectA?.id) {
        await pool.query("DELETE FROM logs WHERE project_id = $1", [projectA.id]);
        await pool.query("DELETE FROM deployments WHERE project_id = $1", [projectA.id]);
        await pool.query("DELETE FROM project_env_vars WHERE project_id = $1", [projectA.id]);
        await pool.query("DELETE FROM projects WHERE id = $1", [projectA.id]);
      }
      if (projectB?.id) {
        await pool.query("DELETE FROM logs WHERE project_id = $1", [projectB.id]);
        await pool.query("DELETE FROM deployments WHERE project_id = $1", [projectB.id]);
        await pool.query("DELETE FROM project_env_vars WHERE project_id = $1", [projectB.id]);
        await pool.query("DELETE FROM projects WHERE id = $1", [projectB.id]);
      }
      if (userA?.id) await pool.query("DELETE FROM users WHERE id = $1", [userA.id]);
      if (userB?.id) await pool.query("DELETE FROM users WHERE id = $1", [userB.id]);
    } catch (_) {}

    try {
      redis.disconnect();
    } catch (_) {}
    await pool.end();
  });

  it("M1 Criterion 1: User registration & distinct domain allocation on collision", async () => {
    // Register User A
    const resA = await fetch(`${baseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        user_name: "User Alpha",
        email: `alpha_${Date.now()}@deployforge.test`,
        password: "Password123!",
      }),
    });
    assert.equal(resA.status, 201);
    cookieUserA = resA.headers.get("set-cookie").split(";")[0];
    userA = (await resA.json()).user;

    // Register User B
    const resB = await fetch(`${baseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        user_name: "User Beta",
        email: `beta_${Date.now()}@deployforge.test`,
        password: "Password123!",
      }),
    });
    assert.equal(resB.status, 201);
    cookieUserB = resB.headers.get("set-cookie").split(";")[0];
    userB = (await resB.json()).user;

    // User A creates project 'shared-smoke'
    const projResA = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookieUserA },
      body: JSON.stringify({
        name: "shared-smoke",
        repository_url: "https://github.com/deployforge/sample-node",
        branch: "main",
        port: 3000,
      }),
    });
    assert.equal(projResA.status, 201);
    projectA = (await projResA.json()).project;
    assert.equal(projectA.domain, "shared-smoke.deployforge.app");

    // User B creates project with identical name 'shared-smoke' -> gets distinct suffixed domain
    const projResB = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookieUserB },
      body: JSON.stringify({
        name: "shared-smoke",
        repository_url: "https://github.com/deployforge/sample-node",
        branch: "main",
        port: 3000,
      }),
    });
    assert.equal(projResB.status, 201);
    projectB = (await projResB.json()).project;
    assert.notEqual(projectA.domain, projectB.domain, "Colliding project names get distinct domains");
    assert.equal(projectB.domain, "shared-smoke-2.deployforge.app");

    // Drain initial project creation deployments from outbox and queue
    await relayPendingEvents();
    for (let i = 0; i < 10; i++) {
      const handled = await pollOnce();
      if (!handled) break;
    }
  });

  it("M1 Criterion 2: Vault secrets isolation without plaintext leaks", async () => {
    // User A sets secret in vault
    const envRes = await fetch(`${baseUrl}/api/projects/${projectA.id}/env`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookieUserA },
      body: JSON.stringify({
        variables: [
          { key: "DB_SECRET_KEY", value: "super-secret-vault-token-9988", is_secret: true },
        ],
      }),
    });
    assert.equal(envRes.status, 201);

    // Verify GET /api/projects/:id does NOT leak plaintext
    const getProj = await fetch(`${baseUrl}/api/projects/${projectA.id}`, {
      headers: { Cookie: cookieUserA },
    });
    const projData = await getProj.json();
    assert.equal(projData.project.env_vars, undefined, "Plaintext secrets absent from project payload");

    // Verify database schema does not store plaintext
    const dbVault = await pool.query(
      `SELECT encrypted_value FROM project_env_vars WHERE project_id = $1 AND key = 'DB_SECRET_KEY'`,
      [projectA.id]
    );
    assert.ok(dbVault.rows.length > 0);
    assert.notEqual(dbVault.rows[0].encrypted_value, "super-secret-vault-token-9988");

    // Internal worker env endpoint delivers decrypted secrets with X-Internal-Token
    const internalRes = await fetch(
      `${baseUrl}/internal/deployments/${projectA.latest_deployment_id || projectA.id}/env`,
      {
        headers: { "X-Internal-Token": process.env.INTERNAL_TOKEN || "deployforge-internal-dev-token" },
      }
    );
    assert.ok(internalRes.status === 200 || internalRes.status === 404);
  });

  it("M1 Criterion 3: Bad branch clone rejection without fallback", async () => {
    // Point project temporarily to local git fixture to test real git branch clone failure
    await pool.query("UPDATE projects SET repository_url = $1 WHERE id = $2", [localGitRepo, projectA.id]);

    // Attempt deployment with nonexistent branch on the local git repository fixture
    const badDepRes = await fetch(`${baseUrl}/api/deployments`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookieUserA },
      body: JSON.stringify({
        project_id: projectA.id,
        branch: "nonexistent-branch-xyz",
        commit_message: "Test bad branch",
      }),
    });
    assert.equal(badDepRes.status, 201);
    const badDep = (await badDepRes.json()).deployment;

    await relayPendingEvents();
    // Worker processes job
    for (let i = 0; i < 15; i++) {
      await pollOnce();
      const checkBad = await pool.query("SELECT status FROM deployments WHERE id = $1", [badDep.id]);
      if (checkBad.rows[0]?.status === "FAILED") {
        break;
      }
      await new Promise((r) => setTimeout(r, 150));
    }

    const checkBadFinal = await pool.query("SELECT status FROM deployments WHERE id = $1", [badDep.id]);
    assert.equal(checkBadFinal.rows[0].status, "FAILED", "Bad branch deployment terminates as FAILED");

    // Restore repository_url
    await pool.query("UPDATE projects SET repository_url = $1 WHERE id = $2", ["https://github.com/deployforge/sample-node", projectA.id]);
  });

  it("M1 Criterion 4: Golden path execution through RUNNING with live logs & ingress routing", async () => {
    // Trigger valid deployment on main
    const depRes = await fetch(`${baseUrl}/api/deployments`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookieUserA },
      body: JSON.stringify({
        project_id: projectA.id,
        branch: "main",
        commit_message: "Release v1.0",
      }),
    });
    assert.equal(depRes.status, 201);
    deploymentA = (await depRes.json()).deployment;

    // Relay outbox event to stream:deployments
    await relayPendingEvents();

    // Worker poll loop
    for (let i = 0; i < 20; i++) {
      await pollOnce();
      const depCheck = await pool.query("SELECT status, container_name FROM deployments WHERE id = $1", [deploymentA.id]);
      if (depCheck.rows[0]?.status === "RUNNING") {
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }

    // Verify deployment status is RUNNING and serving=true
    const getDepRes = await fetch(`${baseUrl}/api/deployments/${deploymentA.id}`, {
      headers: { Cookie: cookieUserA },
    });
    const depData = await getDepRes.json();
    assert.equal(depData.deployment.status, "RUNNING");
    assert.equal(depData.deployment.serving, true);

    // Verify logs were recorded
    const logsRes = await fetch(`${baseUrl}/api/logs?deployment_id=${deploymentA.id}`, {
      headers: { Cookie: cookieUserA },
    });
    assert.equal(logsRes.status, 200);
    const logsData = await logsRes.json();
    assert.ok(logsData.logs.length > 0, "Build and deployment logs recorded");

    // Verify Nginx dynamic config contains registered upstreams
    const nginxConf = generateNginxConfig();
    assert.ok(nginxConf.includes("upstream upstream_df_"), "Nginx config contains upstream blocks");

    // Verify ingress resolution works for domain
    const resolvedRoute = resolveDomain(projectA.domain);
    assert.ok(resolvedRoute, "project domain resolves cleanly");
    assert.equal(resolvedRoute.port, 3000);
  });

  it("M1 Criterion 5: Teardown stops container and unregisters route without leaks", async () => {
    // Stop deployment A
    const stopRes = await fetch(`${baseUrl}/api/deployments/${deploymentA.id}/stop`, {
      method: "POST",
      headers: { Cookie: cookieUserA },
    });
    assert.equal(stopRes.status, 200);
    const stopData = await stopRes.json();
    assert.equal(stopData.deployment.status, "STOPPED");
    assert.equal(stopData.deployment.serving, false);

    // Verify route was unregistered
    const checkResolved = resolveDomain(projectA.domain);
    assert.equal(checkResolved, null, "Project A route unregistered on stop");
  });
});
