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
const deploymentRoutes = require("../routes/deployments.js");
const authRoutes = require("../routes/auth.js");
const logRoutes = require("../routes/logs.js");
const { ensurePersistenceGroup } = require("../services/deploymentEvents.js");

const { processEvent } = require("../workers/persistenceWorker.js");

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

describe("F-15: Real-time Log Streaming & Persistence Ingestion", () => {
  let server;
  let baseUrl;
  let userCookie;
  let testUserId;
  let testProjectId;
  let testDeploymentId;

  before(async () => {
    try {
      if (redis.status !== "ready" && redis.status !== "connecting") {
        await redis.connect().catch(() => {});
      }
    } catch (_) {}

    await ensurePersistenceGroup();

    const app = createApp();
    server = app.listen(0);
    const port = server.address().port;
    baseUrl = `http://127.0.0.1:${port}`;

    // Register user
    const regRes = await fetch(`${baseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        user_name: "Log Streamer",
        email: `f15_${Date.now()}@test.com`,
        password: "Password123!",
      }),
    });
    assert.equal(regRes.status, 201);
    userCookie = regRes.headers.get("set-cookie");
    const regData = await regRes.json();
    testUserId = regData.user.id;

    // Create project
    const projRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: userCookie },
      body: JSON.stringify({
        name: `f15-app-${Date.now() % 100000}`,
        repository_url: "https://github.com/deployforge/sample-node",
        branch: "main",
        runtime: "node",
        port: 3000,
      }),
    });
    assert.equal(projRes.status, 201);
    const projData = await projRes.json();
    testProjectId = projData.project.id;

    // Fetch deployment
    const depRes = await fetch(`${baseUrl}/api/deployments?project_id=${testProjectId}`, {
      headers: { Cookie: userCookie },
    });
    const depData = await depRes.json();
    assert(depData.deployments.length > 0);
    testDeploymentId = depData.deployments[0].id;
  });

  after(async () => {
    if (server) {
      if (typeof server.closeAllConnections === "function") {
        server.closeAllConnections();
      }
      await new Promise((r) => server.close(r));
    }
    try {
      if (testUserId) {
        await pool.query("DELETE FROM users WHERE id = $1", [testUserId]);
      }
    } catch (_) {}
    try {
      redis.disconnect();
    } catch (_) {}
    try {
      await pool.end();
    } catch (_) {}
  });

  it("Test 1: persistenceWorker on LOG_EMITTED inserts into PostgreSQL and PUBLISHes to Redis logs:<deploymentId>", async () => {
    const sub = redis.duplicate();
    let timeout;
    try {
      if (sub.status !== "ready" && sub.status !== "connecting") {
        await sub.connect().catch(() => {});
      }

      const logChannel = `logs:${testDeploymentId}`;
      await sub.subscribe(logChannel);

      const messagePromise = new Promise((resolve, reject) => {
        timeout = setTimeout(() => reject(new Error("Timeout waiting for Redis pub/sub message")), 4000);
        sub.on("message", (channel, message) => {
          if (channel === logChannel) {
            try {
              const parsed = JSON.parse(message);
              if (parsed.message === "F15_PUBSUB_VERIFICATION_MESSAGE_101") {
                clearTimeout(timeout);
                resolve(parsed);
              }
            } catch (_) {}
          }
        });
      });

      const eventPayload = {
        deployment_id: testDeploymentId,
        project_id: testProjectId,
        user_id: testUserId,
        level: "INFO",
        source: "builder",
        message: "F15_PUBSUB_VERIFICATION_MESSAGE_101",
      };

      const processed = await processEvent(
        "1700000000001-0",
        "LOG_EMITTED",
        JSON.stringify(eventPayload)
      );
      assert.equal(processed, true, "processEvent returned true for LOG_EMITTED");

      // Await Redis message
      const received = await messagePromise;
      assert.equal(received.deployment_id, testDeploymentId);
      assert.equal(received.message, "F15_PUBSUB_VERIFICATION_MESSAGE_101");
      assert.equal(received.level, "INFO");
      assert.equal(received.source, "builder");
      assert.match(received.timestamp, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/, "Timestamp is ISO formatted");

      // Verify PostgreSQL persistence
      const dbRes = await pool.query(
        "SELECT * FROM logs WHERE deployment_id = $1 AND message = $2",
        [testDeploymentId, "F15_PUBSUB_VERIFICATION_MESSAGE_101"]
      );
      assert.equal(dbRes.rows.length, 1, "Log row persisted in PostgreSQL logs table");
      assert.equal(dbRes.rows[0].project_id, testProjectId);
      assert.equal(dbRes.rows[0].level, "INFO");
    } finally {
      if (timeout) clearTimeout(timeout);
      await sub.unsubscribe().catch(() => {});
      try {
        sub.disconnect();
      } catch (_) {}
    }
  });

  it("Test 2: GET /api/logs returns latest entries in chronological order with ISO timestamps", async () => {
    // Clear out any previous logs for clean comparison
    await pool.query("DELETE FROM logs WHERE deployment_id = $1", [testDeploymentId]);

    // Insert 5 chronologically ordered logs
    const baseTime = Date.now();
    for (let i = 1; i <= 5; i++) {
      await pool.query(
        `INSERT INTO logs (deployment_id, project_id, user_id, level, source, message, created_at)
         VALUES ($1, $2, $3, 'INFO', 'build', $4, $5)`,
        [testDeploymentId, testProjectId, testUserId, `Numbered log line ${i}`, new Date(baseTime + i * 1000)]
      );
    }

    // Query with limit=3 (no since parameter -> must return the LATEST 3 logs in chronological order)
    const res = await fetch(`${baseUrl}/api/logs?deployment_id=${testDeploymentId}&limit=3`, {
      headers: { Cookie: userCookie },
    });
    assert.equal(res.status, 200);
    const data = await res.json();

    assert.equal(data.logs.length, 3, "Returned requested limit of 3 logs");
    // Latest 3 should be lines 3, 4, 5
    assert.equal(data.logs[0].message, "Numbered log line 3");
    assert.equal(data.logs[1].message, "Numbered log line 4");
    assert.equal(data.logs[2].message, "Numbered log line 5");

    // Check ISO timestamp formatting
    for (const log of data.logs) {
      assert.match(log.timestamp, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z$/, "Timestamp is ISO-8601");
      assert.match(log.created_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z$/, "created_at is ISO-8601");
    }
  });

  it("Test 3: GET /api/logs/stream delivers live logs via Redis Pub/Sub", async () => {
    const streamController = new AbortController();
    const streamPromise = new Promise(async (resolve, reject) => {
      try {
        const streamRes = await fetch(
          `${baseUrl}/api/logs/stream?deployment_id=${testDeploymentId}`,
          {
            headers: { Cookie: userCookie },
            signal: streamController.signal,
          }
        );

        assert(streamRes.headers.get("content-type")?.includes("text/event-stream"));

        const reader = streamRes.body.getReader();
        const decoder = new TextDecoder();
        let receivedData = "";

        // Publish live log to Redis channel directly after connection
        setTimeout(async () => {
          const liveEntry = {
            id: "fake-live-sse-id-123",
            deployment_id: testDeploymentId,
            project_id: testProjectId,
            user_id: testUserId,
            level: "INFO",
            source: "runtime",
            message: "F15_SSE_STREAM_VERIFIED_9999",
            created_at: new Date().toISOString(),
          };
          await redis.publish(`logs:${testDeploymentId}`, JSON.stringify(liveEntry));
        }, 150);

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          receivedData += decoder.decode(value, { stream: true });
          if (receivedData.includes("F15_SSE_STREAM_VERIFIED_9999")) {
            streamController.abort();
            await reader.cancel().catch(() => {});
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
  });
});
