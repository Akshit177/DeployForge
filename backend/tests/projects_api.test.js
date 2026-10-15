const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "../.env") });
require("dotenv").config();

const express = require("express");
const cookieParser = require("cookie-parser");
const pool = require("../config/db.js");
const authRoutes = require("../routes/auth.js");
const projectRoutes = require("../routes/projects.js");

function createApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use("/api/auth", authRoutes);
  app.use("/api/projects", projectRoutes);
  return app;
}

async function runTestSuite() {
  console.log("==================================================");
  console.log("  DeployForge Projects API End-to-End Test Suite  ");
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
    // 1. Unauthenticated GET /api/projects returns 401
    const unauthGet = await fetch(`${baseUrl}/api/projects`);
    assert(unauthGet.status === 401, "GET /api/projects without token returns 401 Unauthorized");

    // 2. Unauthenticated POST /api/projects returns 401
    const unauthPost = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "unauth-app" }),
    });
    assert(unauthPost.status === 401, "POST /api/projects without token returns 401 Unauthorized");

    // 3. Register user A
    const userAEmail = `user_a_${Date.now()}@test.com`;
    const regResA = await fetch(`${baseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        user_name: "Developer A",
        email: userAEmail,
        password: "StrongPassword123!",
      }),
    });
    assert(regResA.status === 201, `User A registered successfully (${regResA.status})`);
    const cookieHeaderA = regResA.headers.get("set-cookie");
    const tokenCookieA = cookieHeaderA ? cookieHeaderA.split(";")[0] : "";
    assert(tokenCookieA.startsWith("token="), "User A received HttpOnly JWT token cookie");

    // 4. Verify /api/auth/me returns User A details
    const meResA = await fetch(`${baseUrl}/api/auth/me`, {
      headers: { Cookie: tokenCookieA },
    });
    const meDataA = await meResA.json();
    assert(meResA.status === 200 && meDataA.user.email === userAEmail, "GET /api/auth/me returns authenticated user");

    // 5. POST /api/projects with invalid payload returns 400
    const invalidPost = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: tokenCookieA },
      body: JSON.stringify({ name: "x" }), // too short
    });
    assert(invalidPost.status === 400, "POST /api/projects with short name returns 400 Bad Request");

    // 5a. POST /api/projects with adversarial/invalid repoUrl returns 400
    const invalidRepoPost = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: tokenCookieA },
      body: JSON.stringify({
        name: "bad-repo-app",
        repository_url: "https://github.com/acme/repo; touch /tmp/pwn",
      }),
    });
    assert(invalidRepoPost.status === 400, "POST /api/projects with malicious repoUrl returns 400 Bad Request");

    // 5b. POST /api/projects with branch starting with hyphen returns 400
    const invalidBranchPost = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: tokenCookieA },
      body: JSON.stringify({
        name: "bad-branch-app",
        repository_url: "https://github.com/acme/forge-service",
        branch: "--upload-pack=touch /tmp/pwn",
      }),
    });
    assert(invalidBranchPost.status === 400, "POST /api/projects with flag injection branch returns 400 Bad Request");

    // 5c. POST /api/projects with out-of-bounds port (< 1024) returns 400
    const invalidPortPost = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: tokenCookieA },
      body: JSON.stringify({
        name: "bad-port-app",
        repository_url: "https://github.com/acme/forge-service",
        port: 80, // Privileged port below 1024
      }),
    });
    assert(invalidPortPost.status === 400, "POST /api/projects with port < 1024 returns 400 Bad Request");

    // 6. POST /api/projects creates project for User A
    await pool.query("DELETE FROM projects WHERE name = 'forge-service' OR domain LIKE 'forge-service%.deployforge.app'");
    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: tokenCookieA },
      body: JSON.stringify({
        name: "forge-service",
        repository_url: "https://github.com/acme/forge-service",
        branch: "main",
        runtime: "node",
        port: 4000,
        auto_deploy: true,
        env_vars: [{ key: "NODE_ENV", value: "production" }],
      }),
    });
    const createData = await createRes.json();
    assert(createRes.status === 201, "POST /api/projects returns 201 Created");
    assert(createData.project.name === "forge-service", "Created project has expected name");
    assert(createData.project.domain === "forge-service.deployforge.app", "Created project generated valid domain");
    assert(createData.project.port === 4000, "Created project stored internal port");
    const projectId = createData.project.id;

    // 7. POST /api/projects duplicate name for User A returns 409
    const dupRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: tokenCookieA },
      body: JSON.stringify({
        name: "forge-service",
        repository_url: "https://github.com/acme/forge-service",
      }),
    });
    assert(dupRes.status === 409, "POST /api/projects duplicate name returns 409 Conflict");

    // 8. GET /api/projects lists User A's projects
    const listResA = await fetch(`${baseUrl}/api/projects`, {
      headers: { Cookie: tokenCookieA },
    });
    const listDataA = await listResA.json();
    assert(listResA.status === 200 && listDataA.projects.some((p) => p.id === projectId), "GET /api/projects lists newly created project");

    // 9. GET /api/projects/:id returns details
    const getSingleRes = await fetch(`${baseUrl}/api/projects/${projectId}`, {
      headers: { Cookie: tokenCookieA },
    });
    const getSingleData = await getSingleRes.json();
    assert(getSingleRes.status === 200 && getSingleData.project.id === projectId, "GET /api/projects/:id returns single project");

    // 10. PATCH /api/projects/:id updates configuration
    const patchRes = await fetch(`${baseUrl}/api/projects/${projectId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: tokenCookieA },
      body: JSON.stringify({
        branch: "release-v1",
        port: 8080,
      }),
    });
    const patchData = await patchRes.json();
    assert(patchRes.status === 200 && patchData.project.branch === "release-v1", "PATCH updates branch to release-v1");
    assert(patchData.project.port === 8080, "PATCH updates port to 8080");

    // 11. Cross-tenant authorization check: Register User B
    const userBEmail = `user_b_${Date.now()}@test.com`;
    const regResB = await fetch(`${baseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        user_name: "Developer B",
        email: userBEmail,
        password: "StrongPassword123!",
      }),
    });
    const cookieHeaderB = regResB.headers.get("set-cookie");
    const tokenCookieB = cookieHeaderB ? cookieHeaderB.split(";")[0] : "";

    // User B attempts to access User A's project
    const userBGetA = await fetch(`${baseUrl}/api/projects/${projectId}`, {
      headers: { Cookie: tokenCookieB },
    });
    assert(userBGetA.status === 404, "User B cannot view User A's project (returns 404 Not Found)");

    // User B attempts to update User A's project
    const userBPatchA = await fetch(`${baseUrl}/api/projects/${projectId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: tokenCookieB },
      body: JSON.stringify({ name: "hijacked" }),
    });
    assert(userBPatchA.status === 404, "User B cannot patch User A's project (returns 404 Not Found)");

    // User B attempts to delete User A's project
    const userBDeleteA = await fetch(`${baseUrl}/api/projects/${projectId}`, {
      method: "DELETE",
      headers: { Cookie: tokenCookieB },
    });
    assert(userBDeleteA.status === 404, "User B cannot delete User A's project (returns 404 Not Found)");

    // 12. User A deletes their project
    const deleteRes = await fetch(`${baseUrl}/api/projects/${projectId}`, {
      method: "DELETE",
      headers: { Cookie: tokenCookieA },
    });
    assert(deleteRes.status === 200, "DELETE /api/projects/:id returns 200 OK");

    // 13. Project is now gone
    const getDeletedRes = await fetch(`${baseUrl}/api/projects/${projectId}`, {
      headers: { Cookie: tokenCookieA },
    });
    assert(getDeletedRes.status === 404, "GET /api/projects/:id after deletion returns 404 Not Found");

    console.log("==================================================");
    console.log(`  All tests passed! Total: ${passed}, Failed: ${failed}`);
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
