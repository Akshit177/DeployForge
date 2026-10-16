const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "../.env") });
require("dotenv").config();

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const cookieParser = require("cookie-parser");
const pool = require("../config/db.js");
const redis = require("../config/redis.js");

const projectRoutes = require("../routes/projects.js");
const authRoutes = require("../routes/auth.js");

function createApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use("/api/auth", authRoutes);
  app.use("/api/projects", projectRoutes);
  return app;
}

describe("S-10: PATCH /projects/:id Mass-Assignment & Validation Gaps", () => {
  let server;
  let baseUrl;
  let userCookie;
  let testUserId;
  let testProjectId;
  let initialProject;

  before(async () => {
    try {
      if (redis.status !== "ready" && redis.status !== "connecting") {
        await redis.connect().catch(() => {});
      }
    } catch (_) {}

    const app = createApp();
    server = app.listen(0);
    const port = server.address().port;
    baseUrl = `http://127.0.0.1:${port}`;

    // Register test user
    const regRes = await fetch(`${baseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        user_name: "S10 Tester",
        email: `s10_${Date.now()}@test.com`,
        password: "Password123!",
      }),
    });
    assert.equal(regRes.status, 201);
    userCookie = regRes.headers.get("set-cookie");
    const regData = await regRes.json();
    testUserId = regData.user.id;

    // Create a base project for PATCH testing
    const projRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: userCookie },
      body: JSON.stringify({
        name: `s10-guard-${Date.now() % 100000}`,
        repository_url: "https://github.com/deployforge/guard-app",
        branch: "main",
        runtime: "node",
        port: 3000,
        auto_deploy: true,
      }),
    });
    assert.equal(projRes.status, 201);
    const projData = await projRes.json();
    testProjectId = projData.project.id;
    initialProject = projData.project;
  });

  after(async () => {
    if (server) server.close();
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

  it("Test 1: PATCH with { status: 'Running-FAKE' } returns 400 Bad Request and status is untouched in DB", async () => {
    const beforeDb = await pool.query("SELECT status FROM projects WHERE id = $1", [testProjectId]);
    const statusBefore = beforeDb.rows[0].status;

    const res = await fetch(`${baseUrl}/api/projects/${testProjectId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: userCookie },
      body: JSON.stringify({ status: "Running-FAKE" }),
    });

    assert.equal(res.status, 400, "PATCH with status must return 400 Bad Request");
    const body = await res.json();
    assert.match(body.message, /Cannot modify project status directly/i);

    // Verify DB status was untouched
    const dbRes = await pool.query("SELECT status FROM projects WHERE id = $1", [testProjectId]);
    assert.equal(dbRes.rows[0].status, statusBefore);
    assert.notEqual(dbRes.rows[0].status, "Running-FAKE");
  });

  it("Test 2: PATCH with { port: 99999 } returns 400 Bad Request", async () => {
    const res = await fetch(`${baseUrl}/api/projects/${testProjectId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: userCookie },
      body: JSON.stringify({ port: 99999 }),
    });

    assert.equal(res.status, 400, "Port 99999 must return 400");
    const body = await res.json();
    assert.match(body.message, /Internal container port must be an integer between 1 and 65535/i);
  });

  it("Test 3: PATCH with invalid ports (-1, 'abc', 0) returns 400 Bad Request", async () => {
    for (const invalidPort of [-1, "abc", 0]) {
      const res = await fetch(`${baseUrl}/api/projects/${testProjectId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Cookie: userCookie },
        body: JSON.stringify({ port: invalidPort }),
      });
      assert.equal(res.status, 400, `Port ${invalidPort} must return 400`);
    }
  });

  it("Test 4: PATCH with forbidden fields { user_id, id, latest_commit, domain } ignores them safely", async () => {
    const fakeUserId = "00000000-0000-0000-0000-000000000000";
    const fakeProjectId = "11111111-1111-1111-1111-111111111111";
    const fakeDomain = "hacked.deployforge.app";
    const fakeCommit = "0000000000000000000000000000000000000000";

    const res = await fetch(`${baseUrl}/api/projects/${testProjectId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: userCookie },
      body: JSON.stringify({
        user_id: fakeUserId,
        id: fakeProjectId,
        domain: fakeDomain,
        latest_commit: fakeCommit,
      }),
    });

    assert.equal(res.status, 200, "PATCH with unknown/forbidden fields ignores them without error");
    const body = await res.json();

    // Verify response does not reflect forged attributes
    assert.equal(body.project.id, testProjectId);
    assert.notEqual(body.project.domain, fakeDomain);

    // Verify database row still belongs to testUserId with original testProjectId
    const dbRes = await pool.query("SELECT id, user_id, domain, latest_commit FROM projects WHERE id = $1", [testProjectId]);
    assert.equal(dbRes.rows[0].id, testProjectId);
    assert.equal(dbRes.rows[0].user_id, testUserId);
    assert.notEqual(dbRes.rows[0].domain, fakeDomain);
    assert.notEqual(dbRes.rows[0].latest_commit, fakeCommit);
  });

  it("Test 5: PATCH with invalid repository_url or branch returns 400 Bad Request", async () => {
    // SSRF repo URL
    const ssrfRes = await fetch(`${baseUrl}/api/projects/${testProjectId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: userCookie },
      body: JSON.stringify({ repository_url: "http://169.254.169.254/latest/meta-data" }),
    });
    assert.equal(ssrfRes.status, 400, "SSRF repo URL on PATCH must return 400");

    // Invalid branch
    const branchRes = await fetch(`${baseUrl}/api/projects/${testProjectId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: userCookie },
      body: JSON.stringify({ branch: "--upload-pack=exploit" }),
    });
    assert.equal(branchRes.status, 400, "Flag branch on PATCH must return 400");
  });

  it("Test 6: PATCH with valid { branch: 'develop', port: 8080, repository_url, auto_deploy: false } updates and persists", async () => {
    const validRepo = "https://github.com/deployforge/safe-updated-repo";
    const res = await fetch(`${baseUrl}/api/projects/${testProjectId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: userCookie },
      body: JSON.stringify({
        branch: "develop",
        port: 8080,
        repository_url: validRepo,
        auto_deploy: false,
      }),
    });

    assert.equal(res.status, 200, "Valid PATCH returns 200 OK");
    const body = await res.json();
    assert.equal(body.project.branch, "develop");
    assert.equal(body.project.port, 8080);
    assert.equal(body.project.repository_url, validRepo);
    assert.equal(body.project.auto_deploy, false);

    // Verify in PostgreSQL
    const dbRes = await pool.query(
      "SELECT branch, port, repository_url, auto_deploy FROM projects WHERE id = $1",
      [testProjectId]
    );
    assert.equal(dbRes.rows[0].branch, "develop");
    assert.equal(dbRes.rows[0].port, 8080);
    assert.equal(dbRes.rows[0].repository_url, validRepo);
    assert.equal(dbRes.rows[0].auto_deploy, false);
  });
});
