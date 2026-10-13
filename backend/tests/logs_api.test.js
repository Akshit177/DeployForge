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

async function runTestSuite() {
  console.log("==================================================");
  console.log("  DeployForge Logs & SSE Stream Engine API Tests  ");
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
    // 1. Unauthenticated checks
    const unauthGet = await fetch(`${baseUrl}/api/logs`);
    assert(unauthGet.status === 401, "GET /api/logs without token returns 401 Unauthorized");

    const unauthStream = await fetch(`${baseUrl}/api/logs/stream`);
    assert(unauthStream.status === 401, "GET /api/logs/stream without token returns 401 Unauthorized");

    // 2. Register User A
    const userAEmail = `log_user_a_${Date.now()}@test.com`;
    const regResA = await fetch(`${baseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        user_name: "Logger A",
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
        name: `log-stream-app-${Date.now() % 10000}`,
        repository_url: "https://github.com/acme/log-stream-app",
        branch: "main",
        runtime: "node",
        port: 3000,
      }),
    });
    assert(createProjectRes.status === 201, "Project created successfully");
    const projectData = await createProjectRes.json();
    const projectId = projectData.project.id;

    // 4. Fetch the initial deployment
    const depListRes = await fetch(`${baseUrl}/api/deployments?project_id=${projectId}`, {
      headers: { Cookie: tokenCookieA },
    });
    const depListData = await depListRes.json();
    assert(depListData.deployments.length > 0, "Deployment found for project");
    const deploymentId = depListData.deployments[0].id;

    // 5. Ingest logs via POST /api/logs
    const ingestRes = await fetch(`${baseUrl}/api/logs`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: tokenCookieA },
      body: JSON.stringify([
        {
          deployment_id: deploymentId,
          level: "INFO",
          source: "build",
          message: "Step 1/6 : FROM node:20-alpine",
        },
        {
          deployment_id: deploymentId,
          level: "WARN",
          source: "build",
          message: "npm WARN deprecated package: upgrade recommended",
        },
        {
          deployment_id: deploymentId,
          level: "ERROR",
          source: "runtime",
          message: "Database connection retry exceeded limit",
        },
      ]),
    });
    assert(ingestRes.status === 201, "POST /api/logs batch returned 201 Created");
    const ingestData = await ingestRes.json();
    assert(ingestData.count === 3, "Ingested exactly 3 log lines");

    // 6. Query historical logs via GET /api/logs
    const queryLogsRes = await fetch(`${baseUrl}/api/logs?deployment_id=${deploymentId}`, {
      headers: { Cookie: tokenCookieA },
    });
    assert(queryLogsRes.status === 200, "GET /api/logs returned 200 OK");
    const queryData = await queryLogsRes.json();
    assert(queryData.logs.length >= 3, "Retrieved ingested logs from PostgreSQL");
    const sampleLog = queryData.logs.find((l) => l.level === "WARN");
    assert(Boolean(sampleLog && sampleLog.time), "Log entry formatted with timestamp string");

    // 7. Query with level filter: level=ERROR
    const errorLogsRes = await fetch(`${baseUrl}/api/logs?deployment_id=${deploymentId}&level=ERROR`, {
      headers: { Cookie: tokenCookieA },
    });
    const errorData = await errorLogsRes.json();
    assert(
      errorData.logs.every((l) => l.level === "ERROR"),
      "Level filter strictly returned ERROR level logs"
    );

    // 8. Test SSE Stream endpoint (GET /api/logs/stream)
    const streamController = new AbortController();
    const streamPromise = new Promise(async (resolve, reject) => {
      try {
        const streamRes = await fetch(
          `${baseUrl}/api/logs/stream?deployment_id=${deploymentId}`,
          {
            headers: { Cookie: tokenCookieA },
            signal: streamController.signal,
          }
        );

        assert(
          streamRes.headers.get("content-type")?.includes("text/event-stream"),
          "SSE stream returns Content-Type: text/event-stream"
        );

        const reader = streamRes.body.getReader();
        const decoder = new TextDecoder();
        let receivedData = "";

        // Push a live log while stream is connected
        setTimeout(async () => {
          await fetch(`${baseUrl}/api/logs`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Cookie: tokenCookieA },
            body: JSON.stringify({
              deployment_id: deploymentId,
              level: "INFO",
              source: "live-worker",
              message: "LIVE_STREAM_VERIFICATION_MESSAGE_42",
            }),
          });
        }, 100);

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          receivedData += decoder.decode(value, { stream: true });
          if (receivedData.includes("LIVE_STREAM_VERIFICATION_MESSAGE_42")) {
            assert(true, "Received live pushed log event over active SSE stream");
            streamController.abort();
            resolve();
            return;
          }
        }
      } catch (err) {
        if (err.name === "AbortError") {
          resolve();
        } else {
          reject(err);
        }
      }
    });

    await streamPromise;

    // 9. Cross-tenant isolation
    const userBEmail = `log_user_b_${Date.now()}@test.com`;
    const regResB = await fetch(`${baseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        user_name: "Logger B",
        email: userBEmail,
        password: "StrongPassword123!",
      }),
    });
    const cookieHeaderB = regResB.headers.get("set-cookie");
    const tokenCookieB = cookieHeaderB ? cookieHeaderB.split(";")[0] : "";

    const userBLogs = await fetch(`${baseUrl}/api/logs?deployment_id=${deploymentId}`, {
      headers: { Cookie: tokenCookieB },
    });
    const userBData = await userBLogs.json();
    assert(
      userBData.logs.length === 0,
      "User B cannot view User A's logs (tenant isolation enforced)"
    );

    console.log("==================================================");
    console.log(`  All Logs & SSE Engine tests passed! (${passed}/${passed})`);
    console.log("==================================================");
  } finally {
    server.close();
    await pool.end();
  }
}

runTestSuite().catch((err) => {
  console.error("Test execution failed:", err);
  process.exit(1);
});
