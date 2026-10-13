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
  console.log("  DeployForge Encrypted Secrets Vault API Tests   ");
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
    const dummyId = "00000000-0000-0000-0000-000000000000";

    // 1. Unauthenticated checks
    const unauthGet = await fetch(`${baseUrl}/api/projects/${dummyId}/env`);
    assert(unauthGet.status === 401, "GET /api/projects/:id/env without token returns 401 Unauthorized");

    const unauthPost = await fetch(`${baseUrl}/api/projects/${dummyId}/env`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: "SECRET", value: "123" }),
    });
    assert(unauthPost.status === 401, "POST /api/projects/:id/env without token returns 401 Unauthorized");

    // 2. Register User A
    const userAEmail = `vault_user_a_${Date.now()}@test.com`;
    const regResA = await fetch(`${baseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        user_name: "Vault Admin",
        email: userAEmail,
        password: "StrongPassword123!",
      }),
    });
    assert(regResA.status === 201, "User A registered successfully");
    const cookieHeaderA = regResA.headers.get("set-cookie");
    const tokenCookieA = cookieHeaderA ? cookieHeaderA.split(";")[0] : "";

    // 3. Create Project for User A
    const createProjectRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: tokenCookieA },
      body: JSON.stringify({
        name: `vault-app-${Date.now() % 10000}`,
        repository_url: "https://github.com/acme/vault-app",
        branch: "main",
        runtime: "node",
        port: 3000,
      }),
    });
    assert(createProjectRes.status === 201, "Project created successfully");
    const projectData = await createProjectRes.json();
    const projectId = projectData.project.id;

    // 4. Save secrets and env vars via POST /api/projects/:id/env
    const dbSecretValue = "postgres://vault_admin:superSecretPassword99@db.internal:5432/app";
    const apiKeySecretValue = "sk-live-deployforge-secret-token-9988";
    const saveRes = await fetch(`${baseUrl}/api/projects/${projectId}/env`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: tokenCookieA },
      body: JSON.stringify([
        {
          key: "DATABASE_URL",
          value: dbSecretValue,
          is_secret: true,
        },
        {
          key: "STRIPE_API_KEY",
          value: apiKeySecretValue,
          is_secret: true,
        },
        {
          key: "NODE_ENV",
          value: "production",
          is_secret: false,
        },
      ]),
    });
    assert(saveRes.status === 201, "POST /api/projects/:id/env returned 201 Created");
    const saveData = await saveRes.json();
    assert(saveData.env_vars.length === 3, "Saved 3 environment variables");

    // 5. Query without reveal: secrets should be masked
    const maskedRes = await fetch(`${baseUrl}/api/projects/${projectId}/env`, {
      headers: { Cookie: tokenCookieA },
    });
    assert(maskedRes.status === 200, "GET /api/projects/:id/env returned 200 OK");
    const maskedData = await maskedRes.json();
    const maskedDb = maskedData.env_vars.find((v) => v.key === "DATABASE_URL");
    assert(maskedDb && maskedDb.value.includes("••••"), "Secret value is securely masked by default");
    const nodeEnvVar = maskedData.env_vars.find((v) => v.key === "NODE_ENV");
    assert(nodeEnvVar && nodeEnvVar.value === "production", "Non-secret value displayed unmasked");

    // 6. Query with reveal=true: decrypted secrets match original plaintext
    const revealRes = await fetch(`${baseUrl}/api/projects/${projectId}/env?reveal=true`, {
      headers: { Cookie: tokenCookieA },
    });
    const revealData = await revealRes.json();
    const revealedDb = revealData.env_vars.find((v) => v.key === "DATABASE_URL");
    assert(revealedDb.value === dbSecretValue, "Decrypted secret matches original plaintext exactly");
    const revealedKey = revealData.env_vars.find((v) => v.key === "STRIPE_API_KEY");
    assert(revealedKey.value === apiKeySecretValue, "Decrypted API key matches original plaintext");

    // 7. Verify at-rest encryption in PostgreSQL: NO PLAINTEXT stored
    const dbInspect = await pool.query(
      `SELECT encrypted_value, iv, auth_tag FROM project_env_vars WHERE project_id = $1 AND key = 'DATABASE_URL'`,
      [projectId]
    );
    assert(dbInspect.rows.length === 1, "Direct DB check found record");
    const dbRow = dbInspect.rows[0];
    assert(!dbRow.encrypted_value.includes("superSecretPassword"), "Database does NOT store plaintext secret");
    assert(Boolean(dbRow.iv && dbRow.auth_tag), "Database stores AES-256-GCM IV and AuthTag");

    // 8. Upsert update existing key
    const updateRes = await fetch(`${baseUrl}/api/projects/${projectId}/env`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: tokenCookieA },
      body: JSON.stringify({
        key: "NODE_ENV",
        value: "staging",
        is_secret: false,
      }),
    });
    assert(updateRes.status === 201, "Upsert returned 201");
    const verifyUpdate = await fetch(`${baseUrl}/api/projects/${projectId}/env?reveal=true`, {
      headers: { Cookie: tokenCookieA },
    });
    const verifyData = await verifyUpdate.json();
    const updatedNodeEnv = verifyData.env_vars.find((v) => v.key === "NODE_ENV");
    assert(updatedNodeEnv.value === "staging", "Upsert updated existing variable value");

    // 9. Delete variable
    const deleteRes = await fetch(`${baseUrl}/api/projects/${projectId}/env/STRIPE_API_KEY`, {
      method: "DELETE",
      headers: { Cookie: tokenCookieA },
    });
    assert(deleteRes.status === 200, "DELETE /api/projects/:id/env/:key returned 200 OK");
    const postDeleteRes = await fetch(`${baseUrl}/api/projects/${projectId}/env`, {
      headers: { Cookie: tokenCookieA },
    });
    const postDeleteData = await postDeleteRes.json();
    assert(
      !postDeleteData.env_vars.some((v) => v.key === "STRIPE_API_KEY"),
      "Deleted variable removed from vault"
    );

    // 10. Cross-tenant isolation: User B cannot access User A's secrets
    const userBEmail = `vault_user_b_${Date.now()}@test.com`;
    const regResB = await fetch(`${baseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        user_name: "Vault Hacker B",
        email: userBEmail,
        password: "StrongPassword123!",
      }),
    });
    const cookieHeaderB = regResB.headers.get("set-cookie");
    const tokenCookieB = cookieHeaderB ? cookieHeaderB.split(";")[0] : "";

    const userBGet = await fetch(`${baseUrl}/api/projects/${projectId}/env`, {
      headers: { Cookie: tokenCookieB },
    });
    assert(userBGet.status === 404, "User B cannot view User A's secrets (404 Unauthorized)");

    const userBPost = await fetch(`${baseUrl}/api/projects/${projectId}/env`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: tokenCookieB },
      body: JSON.stringify({ key: "HACK", value: "evil" }),
    });
    assert(userBPost.status === 404, "User B cannot write to User A's secrets (404)");

    const userBDelete = await fetch(`${baseUrl}/api/projects/${projectId}/env/DATABASE_URL`, {
      method: "DELETE",
      headers: { Cookie: tokenCookieB },
    });
    assert(userBDelete.status === 404, "User B cannot delete User A's secrets (404)");

    console.log("==================================================");
    console.log(`  All Secrets Vault tests passed! (${passed}/${passed})`);
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
