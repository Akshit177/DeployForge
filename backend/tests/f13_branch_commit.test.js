const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "../.env") });
require("dotenv").config();

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const { execSync } = require("child_process");
const pool = require("../config/db.js");
const redis = require("../config/redis.js");
const { processJob } = require("../workers/deploymentWorker.js");
const { processEvent } = require("../workers/persistenceWorker.js");
const { publishDeploymentEvent, ensurePersistenceGroup } = require("../services/deploymentEvents.js");

describe("F-13: Wrong-branch fallback elimination and commit_hash persistence", () => {
  let testUserId;
  let testProjectId;
  let testRepoDir;
  let commit1Sha;
  let commit2Sha;

  before(async () => {
    await ensurePersistenceGroup();

    try {
      if (redis.status !== "ready" && redis.status !== "connecting") {
        await redis.connect().catch(() => {});
      }
    } catch (_) {}

    // Seed test user
    const userRes = await pool.query(
      `INSERT INTO users (name, email, password_hash)
       VALUES ($1, $2, $3)
       RETURNING id`,
      ["F13 Test User", `f13_${Date.now()}@test.com`, "dummy_hash"]
    );
    testUserId = userRes.rows[0].id;

    // Create a local git repository fixture
    testRepoDir = fs.mkdtempSync(path.join(os.tmpdir(), "df_test_repo_"));
    execSync("git init -b main", { cwd: testRepoDir });
    execSync("git config user.name 'Test Committer'", { cwd: testRepoDir });
    execSync("git config user.email 'committer@deployforge.test'", { cwd: testRepoDir });

    // Commit 1 on main
    fs.writeFileSync(path.join(testRepoDir, "app.js"), "console.log('v1');\n");
    fs.writeFileSync(path.join(testRepoDir, "Dockerfile"), "FROM alpine:latest\nCMD [\"echo\", \"v1\"]\n");
    execSync("git add .", { cwd: testRepoDir });
    execSync("git commit -m 'Initial release v1'", { cwd: testRepoDir });
    commit1Sha = execSync("git rev-parse HEAD", { cwd: testRepoDir }).toString().trim();

    // Commit 2 on main
    fs.writeFileSync(path.join(testRepoDir, "app.js"), "console.log('v2');\n");
    execSync("git add .", { cwd: testRepoDir });
    execSync("git commit -m 'Feature release v2'", { cwd: testRepoDir });
    commit2Sha = execSync("git rev-parse HEAD", { cwd: testRepoDir }).toString().trim();

    // Seed test project
    const projRes = await pool.query(
      `INSERT INTO projects (user_id, name, repository_url, domain, port, status, latest_commit)
       VALUES ($1, $2, $3, $4, 3000, 'QUEUED', 'HEAD')
       RETURNING id`,
      [testUserId, `f13-app-${Date.now() % 10000}`, testRepoDir, `f13-${Date.now() % 10000}.deployforge.app`]
    );
    testProjectId = projRes.rows[0].id;
  });

  after(async () => {
    try {
      if (testRepoDir && fs.existsSync(testRepoDir)) {
        fs.rmSync(testRepoDir, { recursive: true, force: true });
      }
      if (testUserId) {
        await pool.query("DELETE FROM users WHERE id = $1", [testUserId]);
      }
    } catch (_) {}

    try {
      redis.disconnect();
    } catch (_) {}
    await pool.end();
  });

  it("Test 1: Bogus branch fails clone and transitions to FAILED instead of falling back to default branch", async () => {
    // Create deployment with nonexistent branch
    const depRes = await pool.query(
      `INSERT INTO deployments (project_id, user_id, branch, commit_hash, status)
       VALUES ($1, $2, 'nonexistent-branch-xyz', 'HEAD', 'QUEUED')
       RETURNING id`,
      [testProjectId, testUserId]
    );
    const depId = depRes.rows[0].id;

    // Process job with deployment worker
    await processJob(
      {
        deployment_id: depId,
        project_id: testProjectId,
        user_id: testUserId,
        repo_url: testRepoDir,
        branch: "nonexistent-branch-xyz",
        commit_hash: "HEAD",
        port: 3000,
      },
      "1700000000001-0"
    );

    // Verify deployment status is strictly FAILED and did not fall back to main
    const checkRes = await pool.query(
      `SELECT status, error_message FROM deployments WHERE id = $1`,
      [depId]
    );
    assert.equal(checkRes.rows[0].status, "FAILED", "Deployment marked FAILED on invalid branch");
    assert.match(
      checkRes.rows[0].error_message || "",
      /Git clone failed/i,
      "Error message explicitly identifies git clone failure"
    );
  });

  it("Test 2: Persistence worker persists commit_hash and commit_message on DEPLOYMENT_COMPLETED", async () => {
    const depRes = await pool.query(
      `INSERT INTO deployments (project_id, user_id, branch, commit_hash, status)
       VALUES ($1, $2, 'main', 'HEAD', 'QUEUED')
       RETURNING id`,
      [testProjectId, testUserId]
    );
    const depId = depRes.rows[0].id;

    const testSha = "9876543210abcdef9876543210abcdef98765432";
    const testMsg = "feat: atomic outbox release";

    await processEvent(
      "1700000000002-0",
      "DEPLOYMENT_COMPLETED",
      JSON.stringify({
        deployment_id: depId,
        project_id: testProjectId,
        user_id: testUserId,
        status: "RUNNING",
        commit_hash: testSha,
        commit_message: testMsg,
        duration_seconds: 5,
        container_id: `c_${depId.replace(/-/g, "").slice(0, 12)}`,
        container_name: `df-${depId.replace(/-/g, "").slice(0, 12)}`,
      })
    );

    // Check deployments table
    const depRow = await pool.query(
      `SELECT status, commit_hash, commit_message FROM deployments WHERE id = $1`,
      [depId]
    );
    assert.equal(depRow.rows[0].status, "RUNNING");
    assert.equal(depRow.rows[0].commit_hash, testSha, "deployments.commit_hash persisted");
    assert.equal(depRow.rows[0].commit_message, testMsg, "deployments.commit_message persisted");

    // Check projects table
    const projRow = await pool.query(
      `SELECT latest_commit FROM projects WHERE id = $1`,
      [testProjectId]
    );
    assert.equal(projRow.rows[0].latest_commit, testSha, "projects.latest_commit updated with resolved SHA");
  });

  it("Test 3: Checkout of specific commit_hash checks out that commit and resolves exact SHA", async () => {
    // Request specifically commit1Sha (which is not HEAD)
    const depRes = await pool.query(
      `INSERT INTO deployments (project_id, user_id, branch, commit_hash, status)
       VALUES ($1, $2, 'main', $3, 'QUEUED')
       RETURNING id`,
      [testProjectId, testUserId, commit1Sha]
    );
    const depId = depRes.rows[0].id;

    await processJob(
      {
        deployment_id: depId,
        project_id: testProjectId,
        user_id: testUserId,
        repo_url: testRepoDir,
        branch: "main",
        commit_hash: commit1Sha,
        port: 3000,
      },
      "1700000000003-0"
    );

    const checkRes = await pool.query(
      `SELECT status, commit_hash, commit_message FROM deployments WHERE id = $1`,
      [depId]
    );
    assert.equal(checkRes.rows[0].status, "RUNNING", "Deployment reached RUNNING");
    assert.equal(checkRes.rows[0].commit_hash, commit1Sha, "Checked out exact commit 1 SHA");
    assert.equal(checkRes.rows[0].commit_message, "Initial release v1", "Resolved commit 1 message");
  });
});
