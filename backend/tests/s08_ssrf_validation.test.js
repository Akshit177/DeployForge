const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "../.env") });
require("dotenv").config();

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const cookieParser = require("cookie-parser");
const pool = require("../config/db.js");
const redis = require("../config/redis.js");

const {
  isValidRepoUrl,
  isValidBranch,
  isValidCommitHash,
  sanitizeCommitMessage,
  isValidTrigger,
  isValidEnvironment,
} = require("../utils/validators.js");

const projectRoutes = require("../routes/projects.js");
const deploymentRoutes = require("../routes/deployments.js");
const authRoutes = require("../routes/auth.js");

function createApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use("/api/auth", authRoutes);
  app.use("/api/projects", projectRoutes);
  app.use("/api/deployments", deploymentRoutes);
  return app;
}

describe("S-08: Repository URL SSRF Prevention & Branch/Commit Validation", () => {
  let server;
  let baseUrl;
  let userCookie;
  let testUserId;
  let testProjectId;

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
        user_name: "S08 Tester",
        email: `s08_${Date.now()}@test.com`,
        password: "Password123!",
      }),
    });
    assert.equal(regRes.status, 201);
    userCookie = regRes.headers.get("set-cookie");
    const regData = await regRes.json();
    testUserId = regData.user.id;

    // Create a valid test project for deployment tests
    const projRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: userCookie },
      body: JSON.stringify({
        name: `s08-app-${Date.now() % 100000}`,
        repository_url: "https://github.com/deployforge/valid-app",
        branch: "main",
        runtime: "node",
        port: 3000,
      }),
    });
    assert.equal(projRes.status, 201);
    const projData = await projRes.json();
    testProjectId = projData.project.id;
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

  it("Test 1: Validator Unit Tests - isValidRepoUrl rejects SSRF internal targets and non-allowlisted hosts", () => {
    // Rejected SSRF / internal hosts / insecure protocols
    assert.equal(isValidRepoUrl("http://169.254.169.254/latest/meta-data/"), false, "Rejects AWS metadata IP");
    assert.equal(isValidRepoUrl("http://redis:6379/x.git"), false, "Rejects internal redis hostname");
    assert.equal(isValidRepoUrl("http://localhost:5432/db.git"), false, "Rejects localhost");
    assert.equal(isValidRepoUrl("http://127.0.0.1:3000/internal"), false, "Rejects loopback IP");
    assert.equal(isValidRepoUrl("https://evil-attacker.com/exploit.git"), false, "Rejects non-whitelisted domain");
    assert.equal(isValidRepoUrl("ftp://github.com/org/repo"), false, "Rejects non-https scheme");
    assert.equal(isValidRepoUrl("https://github.com/org/repo;rm -rf /"), false, "Rejects injection metacharacters");
    assert.equal(isValidRepoUrl(""), false, "Rejects empty repo url");
    assert.equal(isValidRepoUrl(null), false, "Rejects null repo url");

    // Accepted whitelisted HTTPS repository URLs
    assert.equal(isValidRepoUrl("https://github.com/deployforge/sample-node"), true);
    assert.equal(isValidRepoUrl("https://github.com/deployforge/sample-node.git"), true);
    assert.equal(isValidRepoUrl("https://gitlab.com/enterprise/backend-api"), true);
    assert.equal(isValidRepoUrl("https://bitbucket.org/team-alpha/service.git"), true);
  });

  it("Test 2: Validator Unit Tests - isValidBranch rejects leading hyphens, path traversals, and shell characters", () => {
    // Rejected hostile branch names
    assert.equal(isValidBranch("--upload-pack=evil"), false, "Rejects leading hyphen flag");
    assert.equal(isValidBranch("-b"), false, "Rejects short flag option");
    assert.equal(isValidBranch("../../etc/passwd"), false, "Rejects path traversal ..");
    assert.equal(isValidBranch("main;whoami"), false, "Rejects semicolon injection");
    assert.equal(isValidBranch("feature/`id`"), false, "Rejects backtick injection");
    assert.equal(isValidBranch("branch$(whoami)"), false, "Rejects subshell syntax");
    assert.equal(isValidBranch(""), false, "Rejects empty branch");
    assert.equal(isValidBranch("a".repeat(101)), false, "Rejects branch > 100 characters");

    // Accepted valid branches
    assert.equal(isValidBranch("main"), true);
    assert.equal(isValidBranch("feature/auth-matrix"), true);
    assert.equal(isValidBranch("v1.2.3"), true);
    assert.equal(isValidBranch("release_2026.04-patch"), true);
  });

  it("Test 3: Validator Unit Tests - isValidCommitHash strictly checks hexadecimal length and HEAD", () => {
    // Valid
    assert.equal(isValidCommitHash("HEAD"), true);
    assert.equal(isValidCommitHash("a1b2c3d"), true, "Valid 7-char short SHA");
    assert.equal(isValidCommitHash("0123456789abcdef0123456789abcdef01234567"), true, "Valid 40-char SHA");
    assert.equal(isValidCommitHash(""), true, "Empty defaults to valid");
    assert.equal(isValidCommitHash(undefined), true, "Undefined defaults to valid");

    // Rejected
    assert.equal(isValidCommitHash("$(id)"), false, "Rejects command substitution");
    assert.equal(isValidCommitHash("abcdef"), false, "Rejects < 7 chars hex");
    assert.equal(isValidCommitHash("g1234567"), false, "Rejects non-hex characters");
    assert.equal(isValidCommitHash("0".repeat(41)), false, "Rejects > 40 chars hex");
  });

  it("Test 4: POST /api/projects rejects SSRF target URLs with 400 Bad Request", async () => {
    const maliciousUrls = [
      "http://169.254.169.254/latest/meta-data/",
      "http://redis:6379/x.git",
      "http://localhost:8080/test.git",
      "https://untrusted-host.example.com/repo.git",
    ];

    for (const badUrl of maliciousUrls) {
      const res = await fetch(`${baseUrl}/api/projects`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: userCookie },
        body: JSON.stringify({
          name: `ssrf-test-${Date.now() % 100000}`,
          repository_url: badUrl,
        }),
      });
      assert.equal(res.status, 400, `SSRF URL ${badUrl} must be rejected with 400 Bad Request`);
      const body = await res.json();
      assert.match(body.message, /valid HTTPS repository URL/i);
    }
  });

  it("Test 5: POST /api/projects rejects hostile branch names with 400 Bad Request", async () => {
    const hostileBranches = ["--upload-pack=cat /etc/passwd", "../../secret", "-f", "main;touch /tmp/pwn"];

    for (const badBranch of hostileBranches) {
      const res = await fetch(`${baseUrl}/api/projects`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: userCookie },
        body: JSON.stringify({
          name: `branch-test-${Date.now() % 100000}`,
          repository_url: "https://github.com/deployforge/valid-app",
          branch: badBranch,
        }),
      });
      assert.equal(res.status, 400, `Hostile branch ${badBranch} must be rejected with 400 Bad Request`);
      const body = await res.json();
      assert.match(body.message, /invalid branch name/i);
    }
  });

  it("Test 6: POST /api/deployments rejects unvalidated branch, commit_hash, and trigger", async () => {
    // 1. Rejected hostile branch
    const branchRes = await fetch(`${baseUrl}/api/deployments`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: userCookie },
      body: JSON.stringify({
        project_id: testProjectId,
        branch: "--upload-pack=evil",
      }),
    });
    assert.equal(branchRes.status, 400, "Rejects branch starting with '-'");
    const branchBody = await branchRes.json();
    assert.match(branchBody.message, /invalid branch name/i);

    // 2. Rejected hostile commit hash
    const commitRes = await fetch(`${baseUrl}/api/deployments`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: userCookie },
      body: JSON.stringify({
        project_id: testProjectId,
        commit_hash: "$(cat /etc/shadow)",
      }),
    });
    assert.equal(commitRes.status, 400, "Rejects non-hex commit hash");
    const commitBody = await commitRes.json();
    assert.match(commitBody.message, /invalid commit hash/i);

    // 3. Rejected hostile trigger
    const triggerRes = await fetch(`${baseUrl}/api/deployments`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: userCookie },
      body: JSON.stringify({
        project_id: testProjectId,
        trigger: "manual;rm -rf /",
      }),
    });
    assert.equal(triggerRes.status, 400, "Rejects invalid trigger");
  });

  it("Test 7: POST /api/deployments accepts valid branch and commit hash, and sanitizes long message", async () => {
    const longMsg = "Commit message header\n\x00\x07" + "A".repeat(600);
    const validRes = await fetch(`${baseUrl}/api/deployments`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: userCookie },
      body: JSON.stringify({
        project_id: testProjectId,
        branch: "feature/safe-branch_1",
        commit_hash: "1234567890abcdef1234567890abcdef12345678",
        commit_message: longMsg,
        trigger: "webhook",
        environment: "production",
      }),
    });
    assert.equal(validRes.status, 201, "Valid deployment inputs accepted with 201 Created");
    const data = await validRes.json();
    assert.equal(data.deployment.branch, "feature/safe-branch_1");
    assert.equal(data.deployment.commit_hash, "1234567890abcdef1234567890abcdef12345678");
    assert.ok(data.deployment.message.length <= 500, "Message capped at 500 characters");
    assert.equal(data.deployment.message.includes("\x00"), false, "Control characters stripped");
  });
});
