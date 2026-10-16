const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "../.env") });
require("dotenv").config();

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const cookieParser = require("cookie-parser");
const pool = require("../config/db.js");
const redis = require("../config/redis.js");
const { encrypt, decrypt } = require("../services/crypto.js");

const internalRoutes = require("../routes/internal.js");
const projectRoutes = require("../routes/projects.js");
const authRoutes = require("../routes/auth.js");

function createApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use("/internal", internalRoutes);
  app.use("/api/auth", authRoutes);
  app.use("/api/projects", projectRoutes);
  return app;
}

describe("S-06: Encrypted Environment Variables Vault & Internal Delivery", () => {
  let server;
  let baseUrl;
  let testUser;
  let userCookie;
  let testProjectId;
  let testDeploymentId;
  const INTERNAL_TOKEN = process.env.INTERNAL_TOKEN || "deployforge-internal-dev-token";

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

    // Register a test user
    const userEmail = `s06_test_${Date.now()}@example.com`;
    const regRes = await fetch(`${baseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        user_name: "S06 Tester",
        email: userEmail,
        password: "Password123!",
      }),
    });
    assert.equal(regRes.status, 201, "User registration returns 201");
    userCookie = regRes.headers.get("set-cookie");
    const regData = await regRes.json();
    testUser = regData.user;

    // Seed a project directly in PostgreSQL
    const projRes = await pool.query(
      `INSERT INTO projects (user_id, name, repository_url, branch, runtime, port, status, domain)
       VALUES ($1, $2, $3, 'main', 'node', 5050, 'RUNNING', $4)
       RETURNING id`,
      [testUser.id, `s06-proj-${Date.now() % 100000}`, "https://github.com/deployforge/test-app", `s06-${Date.now() % 100000}.deployforge.app`]
    );
    testProjectId = projRes.rows[0].id;

    // Seed deployment
    const depRes = await pool.query(
      `INSERT INTO deployments (project_id, user_id, status)
       VALUES ($1, $2, 'RUNNING')
       RETURNING id`,
      [testProjectId, testUser.id]
    );
    testDeploymentId = depRes.rows[0].id;

    // Seed encrypted variables into vault (including a blocked key to test filtering)
    const dbEnc = encrypt("postgres://prod:secretpass@db.internal:5432/main");
    const keyEnc = encrypt("sk_live_9876543210abcdef");
    const blockedEnc = encrypt("/malicious/inject.so");

    await pool.query(
      `INSERT INTO project_env_vars (project_id, user_id, key, encrypted_value, iv, auth_tag, is_secret)
       VALUES
         ($1, $2, 'DATABASE_URL', $3, $4, $5, true),
         ($1, $2, 'STRIPE_API_KEY', $6, $7, $8, true),
         ($1, $2, 'LD_PRELOAD', $9, $10, $11, true)`,
      [
        testProjectId, testUser.id,
        dbEnc.ciphertext, dbEnc.iv, dbEnc.authTag,
        keyEnc.ciphertext, keyEnc.iv, keyEnc.authTag,
        blockedEnc.ciphertext, blockedEnc.iv, blockedEnc.authTag,
      ]
    );
  });

  after(async () => {
    if (server) {
      server.close();
    }
    try {
      if (testUser?.id) {
        await pool.query("DELETE FROM users WHERE id = $1", [testUser.id]);
      }
    } catch (_) {}
    try {
      redis.disconnect();
    } catch (_) {}
    await pool.end();
  });

  it("Test 1: GET /internal/deployments/:id/env enforces X-Internal-Token authentication", async () => {
    // Missing token
    const resNoToken = await fetch(`${baseUrl}/internal/deployments/${testDeploymentId}/env`);
    assert.equal(resNoToken.status, 401, "Missing X-Internal-Token returns 401 Unauthorized");
    const noTokenBody = await resNoToken.json();
    assert.match(noTokenBody.error, /invalid or missing internal token/i);

    // Invalid token
    const resBadToken = await fetch(`${baseUrl}/internal/deployments/${testDeploymentId}/env`, {
      headers: { "X-Internal-Token": "wrong-token-abc" },
    });
    assert.equal(resBadToken.status, 401, "Invalid X-Internal-Token returns 401 Unauthorized");
  });

  it("Test 2: GET /internal/deployments/:id/env returns decrypted vault secrets and filters dangerous keys", async () => {
    const res = await fetch(`${baseUrl}/internal/deployments/${testDeploymentId}/env`, {
      headers: { "X-Internal-Token": INTERNAL_TOKEN },
    });
    assert.equal(res.status, 200, "Valid internal token returns 200 OK");

    const data = await res.json();
    assert.ok(data.env, "Response contains env object");
    assert.equal(data.env.DATABASE_URL, "postgres://prod:secretpass@db.internal:5432/main", "DATABASE_URL decrypted accurately");
    assert.equal(data.env.STRIPE_API_KEY, "sk_live_9876543210abcdef", "STRIPE_API_KEY decrypted accurately");
    assert.equal(data.env.PORT, "5050", "Default PORT populated from deployment/project");
    assert.equal(data.env.NODE_ENV, "production", "Default NODE_ENV populated");

    // Blocked dangerous key must NOT be present
    assert.equal(data.env.LD_PRELOAD, undefined, "Dangerous key LD_PRELOAD is filtered out");
  });

  it("Test 3: projects.env_vars column is completely eliminated from PostgreSQL schema", async () => {
    const colCheck = await pool.query(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = 'projects' AND column_name = 'env_vars'
    `);
    assert.equal(colCheck.rows.length, 0, "projects.env_vars column does not exist in database");
  });

  it("Test 4: GET /api/projects and GET /api/projects/:id do not leak plaintext secrets", async () => {
    const listRes = await fetch(`${baseUrl}/api/projects`, {
      headers: { Cookie: userCookie },
    });
    assert.equal(listRes.status, 200);
    const listData = await listRes.json();
    const proj = listData.projects.find((p) => p.id === testProjectId);
    assert.ok(proj, "Found project in list");
    assert.equal(proj.env_vars, undefined, "formatProject does not output env_vars field");

    const singleRes = await fetch(`${baseUrl}/api/projects/${testProjectId}`, {
      headers: { Cookie: userCookie },
    });
    assert.equal(singleRes.status, 200);
    const singleData = await singleRes.json();
    assert.equal(singleData.project.env_vars, undefined, "Single project view does not output env_vars");
  });

  it("Test 5: POST /api/projects/:id/env enforces validation, caps, and blocked keys", async () => {
    // 1. Rejects blocked keys (LD_PRELOAD)
    const blockedRes = await fetch(`${baseUrl}/api/projects/${testProjectId}/env`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: userCookie },
      body: JSON.stringify([{ key: "LD_PRELOAD", value: "/evil.so" }]),
    });
    assert.equal(blockedRes.status, 400, "Rejects reserved key LD_PRELOAD with 400 Bad Request");
    const blockedBody = await blockedRes.json();
    assert.match(blockedBody.message, /reserved/i);

    // 2. Rejects variable values exceeding 8 KB
    const largeValue = "A".repeat(8193);
    const largeRes = await fetch(`${baseUrl}/api/projects/${testProjectId}/env`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: userCookie },
      body: JSON.stringify([{ key: "OVERSIZED_VAL", value: largeValue }]),
    });
    assert.equal(largeRes.status, 400, "Rejects variable value > 8 KB with 400 Bad Request");
    const largeBody = await largeRes.json();
    assert.match(largeBody.message, /8 KB/i);

    // 3. Rejects exceeding 100 variables cap
    const tooMany = [];
    for (let i = 0; i < 105; i++) {
      tooMany.push({ key: `VAR_${i}`, value: `val_${i}` });
    }
    const overflowRes = await fetch(`${baseUrl}/api/projects/${testProjectId}/env`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: userCookie },
      body: JSON.stringify(tooMany),
    });
    assert.equal(overflowRes.status, 400, "Rejects > 100 variables with 400 Bad Request");
    const overflowBody = await overflowRes.json();
    assert.match(overflowBody.message, /100 environment variables/i);
  });

  it("Test 6: POST /api/projects/:id/env is batch-transactional (atomic rollback on error)", async () => {
    // Attempt batch where 1st is valid and 2nd is invalid key syntax
    const batchRes = await fetch(`${baseUrl}/api/projects/${testProjectId}/env`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: userCookie },
      body: JSON.stringify([
        { key: "ROLLBACK_TEST_SHOULD_NOT_EXIST", value: "hello" },
        { key: "INVALID-KEY-WITH-DASHES!", value: "fail" },
      ]),
    });
    assert.equal(batchRes.status, 400, "Batch with invalid item returns 400");

    // Verify ROLLBACK_TEST_SHOULD_NOT_EXIST was NOT committed
    const checkDb = await pool.query(
      `SELECT id FROM project_env_vars WHERE project_id = $1 AND key = 'ROLLBACK_TEST_SHOULD_NOT_EXIST'`,
      [testProjectId]
    );
    assert.equal(checkDb.rows.length, 0, "No partial commit on batch failure; atomic rollback verified");
  });

  it("Test 7: POST /api/projects with initial env_vars stores them encrypted in vault", async () => {
    const newProjName = `s06-new-${Date.now() % 100000}`;
    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: userCookie },
      body: JSON.stringify({
        name: newProjName,
        repository_url: "https://github.com/deployforge/sample-vault",
        branch: "main",
        runtime: "node",
        port: 3000,
        env_vars: [
          { key: "CUSTOM_SECRET_TOKEN", value: "tok_1234567890", isSecret: true },
          { key: "API_HOST", value: "api.partner.io", isSecret: false },
        ],
      }),
    });
    assert.equal(createRes.status, 201, "Project created with initial env vars returns 201");
    const createData = await createRes.json();
    const createdProjectId = createData.project.id;

    // Check project_env_vars table: values must be encrypted
    const vaultRows = await pool.query(
      `SELECT key, encrypted_value, iv, auth_tag, is_secret FROM project_env_vars WHERE project_id = $1 ORDER BY key ASC`,
      [createdProjectId]
    );
    assert.equal(vaultRows.rows.length, 2, "2 vault entries created");

    const hostRow = vaultRows.rows.find((r) => r.key === "API_HOST");
    const tokenRow = vaultRows.rows.find((r) => r.key === "CUSTOM_SECRET_TOKEN");
    assert.ok(hostRow);
    assert.ok(tokenRow);
    assert.equal(tokenRow.is_secret, true);
    assert.notEqual(tokenRow.encrypted_value, "tok_1234567890", "Token is encrypted in DB, not plaintext");
    assert.equal(decrypt(tokenRow.encrypted_value, tokenRow.iv, tokenRow.auth_tag), "tok_1234567890", "Token decrypts correctly");

    // Fetch initial deployment
    const depRow = await pool.query(
      `SELECT id FROM deployments WHERE project_id = $1 ORDER BY created_at ASC LIMIT 1`,
      [createdProjectId]
    );
    const initialDepId = depRow.rows[0].id;

    // Check internal endpoint for initial deployment
    const intRes = await fetch(`${baseUrl}/internal/deployments/${initialDepId}/env`, {
      headers: { "X-Internal-Token": INTERNAL_TOKEN },
    });
    assert.equal(intRes.status, 200);
    const intData = await intRes.json();
    assert.equal(intData.env.CUSTOM_SECRET_TOKEN, "tok_1234567890");
    assert.equal(intData.env.API_HOST, "api.partner.io");
  });
});
