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
const deploymentRoutes = require("../routes/deployments.js");
const logRoutes = require("../routes/logs.js");
const { parsePagination } = require("../middleware/pagination.js");

function createApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use("/api/auth", authRoutes);
  app.use("/api/projects", projectRoutes);
  app.use("/api/deployments", deploymentRoutes);
  app.use("/api/logs", logRoutes);
  return app;
}

describe("P-01: Pagination & Date Filter Middleware Unit Tests", () => {
  it("defaults limit to 50 and offset to 0 when no query params provided", () => {
    const req = { query: {} };
    let nextCalled = false;
    const res = {};
    parsePagination(req, res, () => {
      nextCalled = true;
    });

    assert.equal(nextCalled, true);
    assert.deepEqual(req.pagination, {
      limit: 50,
      offset: 0,
      since: undefined,
      until: undefined,
    });
  });

  it("clamps limit=999 down to max 200", () => {
    const req = { query: { limit: "999" } };
    let nextCalled = false;
    parsePagination(req, {}, () => {
      nextCalled = true;
    });

    assert.equal(nextCalled, true);
    assert.equal(req.pagination.limit, 200);
    assert.equal(req.pagination.offset, 0);
  });

  it("parses valid ISO date for since and until", () => {
    const req = { query: { since: "2024-01-01T00:00:00Z", until: "2024-06-01T00:00:00Z" } };
    let nextCalled = false;
    parsePagination(req, {}, () => {
      nextCalled = true;
    });

    assert.equal(nextCalled, true);
    assert.ok(req.pagination.since instanceof Date);
    assert.ok(req.pagination.until instanceof Date);
    assert.equal(req.pagination.since.toISOString(), "2024-01-01T00:00:00.000Z");
    assert.equal(req.pagination.until.toISOString(), "2024-06-01T00:00:00.000Z");
  });
});

describe("P-01: Table-Driven API Pagination & Date Filter Validation", () => {
  let server;
  let baseUrl;
  let tokenCookie;
  let projectId;
  let userId;

  before(async () => {
    const app = createApp();
    server = app.listen(0);
    const port = server.address().port;
    baseUrl = `http://localhost:${port}`;

    // Register test user
    const userEmail = `pagination_tester_${Date.now()}@test.com`;
    const regRes = await fetch(`${baseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        user_name: "Pagination Tester",
        email: userEmail,
        password: "StrongPassword123!",
      }),
    });
    assert.equal(regRes.status, 201, "Failed to register test user");
    const regData = await regRes.json();
    userId = regData.user.id;
    const cookieHeader = regRes.headers.get("set-cookie");
    tokenCookie = cookieHeader ? cookieHeader.split(";")[0] : "";

    // Create project (creates deployment #1)
    const projRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: tokenCookie },
      body: JSON.stringify({
        name: `pagination-app-${Date.now() % 10000}`,
        repository_url: "https://github.com/acme/pagination-app",
        branch: "main",
        runtime: "node",
        port: 3000,
      }),
    });
    assert.equal(projRes.status, 201, "Failed to create test project");
    const projData = await projRes.json();
    projectId = projData.project.id;
  });

  after(async () => {
    if (server) {
      if (typeof server.closeAllConnections === "function") {
        server.closeAllConnections();
      }
      await new Promise((resolve) => server.close(resolve));
    }
    try {
      const redis = require("../config/redis.js");
      redis.disconnect();
    } catch (_) {}
    try {
      await pool.end();
    } catch (_) {}
  });

  // Table-driven cases as specified by the task roadmap:
  // - limit=-5 → 400
  // - limit=0 → 400
  // - limit=abc → 400
  // - limit=999 → clamped to 200 (valid request, not 400)
  // - offset=-1 → 400
  // - offset=abc → 400
  // - since=not-a-date → 400
  // - since=2024-01-01T00:00:00Z → valid (200)
  // - No params → defaults applied (200)
  const testCases = [
    { name: "limit=-5 → 400", query: "limit=-5", expectedStatus: 400 },
    { name: "limit=0 → 400", query: "limit=0", expectedStatus: 400 },
    { name: "limit=abc → 400", query: "limit=abc", expectedStatus: 400 },
    { name: "limit=999 → clamped to 200 (valid request, not 400)", query: "limit=999", expectedStatus: 200 },
    { name: "offset=-1 → 400", query: "offset=-1", expectedStatus: 400 },
    { name: "offset=abc → 400", query: "offset=abc", expectedStatus: 400 },
    { name: "since=not-a-date → 400", query: "since=not-a-date", expectedStatus: 400 },
    { name: "since=2024-01-01T00:00:00Z → valid (200)", query: "since=2024-01-01T00:00:00Z", expectedStatus: 200 },
    { name: "No params → defaults applied (200)", query: "", expectedStatus: 200 },
  ];

  for (const tc of testCases) {
    it(`GET /api/deployments: ${tc.name}`, async () => {
      const url = tc.query ? `${baseUrl}/api/deployments?${tc.query}` : `${baseUrl}/api/deployments`;
      const res = await fetch(url, {
        headers: { Cookie: tokenCookie },
      });
      assert.equal(
        res.status,
        tc.expectedStatus,
        `Expected status ${tc.expectedStatus} for GET ${url}, received ${res.status}`
      );
      if (tc.expectedStatus === 200) {
        const data = await res.json();
        assert.ok(Array.isArray(data.deployments));
      }
    });
  }

  // Cross-endpoint verification: projects and logs endpoints also enforce pagination & date filters
  it("GET /api/projects: limit=-5 → 400", async () => {
    const res = await fetch(`${baseUrl}/api/projects?limit=-5`, {
      headers: { Cookie: tokenCookie },
    });
    assert.equal(res.status, 400);
  });

  it("GET /api/projects: valid pagination returns 200", async () => {
    const res = await fetch(`${baseUrl}/api/projects?limit=10&offset=0`, {
      headers: { Cookie: tokenCookie },
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(Array.isArray(data.projects));
  });

  it("GET /api/logs: limit=abc → 400", async () => {
    const res = await fetch(`${baseUrl}/api/logs?limit=abc`, {
      headers: { Cookie: tokenCookie },
    });
    assert.equal(res.status, 400);
  });

  it("GET /api/logs: since=not-a-date → 400", async () => {
    const res = await fetch(`${baseUrl}/api/logs?since=not-a-date`, {
      headers: { Cookie: tokenCookie },
    });
    assert.equal(res.status, 400);
  });

  it("GET /api/logs: valid query params return 200", async () => {
    const res = await fetch(`${baseUrl}/api/logs?limit=50&offset=0&since=2024-01-01T00:00:00Z`, {
      headers: { Cookie: tokenCookie },
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(Array.isArray(data.logs));
  });

  it("auth fallback: req.user does not leak password or password_hash when authenticating without Redis session", async () => {
    const { generateAccessToken } = require("../services/auth.js");
    const { authenticateToken } = require("../middleware/auth.js");

    const noSessionToken = generateAccessToken(userId, null);
    const mockReq = {
      cookies: { token: noSessionToken },
      headers: {},
    };
    let nextCalled = false;
    const mockRes = {
      status: (code) => ({
        json: (body) => {
          throw new Error(`Unexpected error response: ${code} ${JSON.stringify(body)}`);
        },
      }),
    };

    await authenticateToken(mockReq, mockRes, () => {
      nextCalled = true;
    });

    assert.equal(nextCalled, true);
    assert.ok(mockReq.user, "req.user should be populated");
    assert.equal(mockReq.user.id, userId);
    assert.equal(mockReq.user.password, undefined, "req.user must not contain password");
    assert.equal(mockReq.user.password_hash, undefined, "req.user must not contain password_hash");

    // Also verify via HTTP GET /api/auth/me using the no-session token
    const res = await fetch(`${baseUrl}/api/auth/me`, {
      headers: { Cookie: `token=${noSessionToken}` },
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.user.password, undefined);
    assert.equal(data.user.password_hash, undefined);
  });
});
