const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");
const express = require("express");
const pool = require("../config/db.js");
const redis = require("../config/redis.js");

// Force simulator mode for CI / local test environment without running Docker Desktop
process.env.DOCKER_MODE = "simulator";

const {
  isDockerAvailable,
  buildImage,
  createContainer,
  startContainer,
  inspectContainer,
  stopContainer,
  removeContainer,
  getMode,
} = require("../services/dockerClient.js");

const {
  isValidDeploymentId,
  getWorkspacePath,
  cleanupWorkspace,
  detectRuntime,
  prepareWorkspaceDockerfile,
} = require("../services/runtimeDetector.js");

const { probeContainerEndpoint } = require("../services/healthCheck.js");
const {
  registerUpstreamRoute,
  unregisterUpstreamRoute,
  getRoutingTable,
  generateNginxConfig,
} = require("../services/proxyRouter.js");

const {
  syncNginxConfig,
  validateNginxConfig,
  reloadNginx,
  UPSTREAMS_CONF_FILE,
  INGRESS_CONF_FILE,
} = require("../services/nginxManager.js");

const { processJob } = require("../workers/deploymentWorker.js");
const { getDeploymentHotState } = require("../services/hotState.js");

describe("Phase C: Docker Daemon Integration & Nginx Data Plane Suite", () => {
  let testUser;
  let testProject;

  before(async () => {
    // Seed test user
    const userRes = await pool.query(
      `INSERT INTO users (name, email, password_hash)
       VALUES ($1, $2, $3)
       RETURNING *`,
      ["PhaseC Tester", `phasec_${Date.now()}@test.internal`, "hashed_test_pw"]
    );
    testUser = userRes.rows[0];

    // Seed test project
    const projRes = await pool.query(
      `INSERT INTO projects (user_id, name, repository_url, branch, runtime, port, domain)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        testUser.id,
        "phasec-service",
        "https://github.com/deployforge/sample-node",
        "main",
        "node",
        3000,
        `phasec-service-${Date.now()}.deployforge.app`,
      ]
    );
    testProject = projRes.rows[0];
  });

  after(async () => {
    if (testUser) {
      await pool.query(`DELETE FROM users WHERE id = $1`, [testUser.id]).catch(() => {});
    }
    setTimeout(() => process.exit(0), 100);
  });

  describe("1. Dual-Mode Docker Client", () => {
    it("reports configured simulator mode", () => {
      assert.equal(getMode(), "simulator");
    });

    it("pings Docker availability successfully in simulator", async () => {
      const avail = await isDockerAvailable();
      assert.equal(avail, true);
    });

    it("builds image from context directory", async () => {
      const res = await buildImage(os.tmpdir(), "df-test-img:latest");
      assert.ok(res.imageId);
      assert.equal(res.imageName, "df-test-img:latest");
    });

    it("creates, starts, inspects, stops, and removes container", async () => {
      const created = await createContainer({
        imageName: "df-test-img:latest",
        containerName: "df-test-container",
        containerPort: 3000,
        env: { NODE_ENV: "production", PORT: "3000" },
        networkName: "deployforge-apps",
        resourceLimits: { memoryMB: 512, cpuShares: 256, pidsLimit: 100 },
      });
      assert.ok(created.containerId);
      assert.equal(created.containerName, "df-test-container");

      const started = await startContainer(created.containerId);
      assert.equal(started.started, true);

      const inspected = await inspectContainer(created.containerId);
      assert.equal(inspected.running, true);
      assert.ok(inspected.networkIp);

      const stopped = await stopContainer(created.containerId);
      assert.equal(stopped.stopped, true);

      const removed = await removeContainer(created.containerId);
      assert.equal(removed.removed, true);
    });
  });

  describe("2. Workspace Isolation & Runtime Detection", () => {
    it("rejects path traversal in deployment IDs", () => {
      assert.equal(isValidDeploymentId("../../../etc/shadow"), false);
      assert.equal(isValidDeploymentId("test-id/escaped"), false);
      assert.throws(() => getWorkspacePath("../../bad"), /Invalid deploymentId/);
    });

    it("creates isolated workspace directory per deployment ID", () => {
      const depId = "11111111-2222-3333-4444-555555555555";
      const ws = getWorkspacePath(depId);
      assert.ok(fs.existsSync(ws));
      assert.ok(ws.includes(depId));
      cleanupWorkspace(ws);
      assert.equal(fs.existsSync(ws), false);
    });

    it("detects root Dockerfile in workspace", () => {
      const depId = "dockerfile-detection-test";
      const ws = getWorkspacePath(depId);
      fs.writeFileSync(
        path.join(ws, "Dockerfile"),
        "FROM node:20-alpine\nWORKDIR /app\nUSER node\nEXPOSE 3000\nCMD [\"node\", \"index.js\"]"
      );

      const info = detectRuntime(ws);
      assert.equal(info.runtime, "dockerfile");
      assert.equal(info.hasCustomDockerfile, true);

      const dfPath = prepareWorkspaceDockerfile(ws, info);
      assert.ok(fs.existsSync(dfPath));
      const content = fs.readFileSync(dfPath, "utf-8");
      assert.ok(content.includes("FROM node:20-alpine"));
      assert.ok(content.includes("USER node"));

      cleanupWorkspace(ws);
    });

    it("strictly rejects repository without root Dockerfile", () => {
      const depId = "no-dockerfile-test";
      const ws = getWorkspacePath(depId);
      fs.writeFileSync(path.join(ws, "index.html"), "<h1>Static Test</h1>");

      assert.throws(() => {
        detectRuntime(ws);
      }, /No root Dockerfile found in repository/);

      cleanupWorkspace(ws);
    });
  });

  describe("3. Health Check Probes (Mode Behavior)", () => {
    it("returns simulated healthy response in simulator mode on unreachable port", async () => {
      const probe = await probeContainerEndpoint({ host: "127.0.0.1", port: 59999, timeoutMs: 100 });
      assert.equal(probe.healthy, true);
      assert.equal(probe.simulated, true);
    });

    it("strictly rejects unreachable container in real mode", async () => {
      // Temporarily toggle mode to real
      process.env.DOCKER_MODE = "real";
      try {
        const probe = await probeContainerEndpoint({ host: "127.0.0.1", port: 59999, timeoutMs: 100 });
        assert.equal(probe.healthy, false);
        assert.ok(probe.error);
      } finally {
        process.env.DOCKER_MODE = "simulator";
      }
    });
  });

  describe("4. Dynamic Nginx Reverse Proxy Configuration & Sync", () => {
    it("generates Nginx upstream and server block config", () => {
      registerUpstreamRoute("test-app.internal", {
        projectId: testProject.id,
        projectName: "test-app",
        deploymentId: "dep-test-123",
        containerId: "c_test123",
        targetHost: "df-dep-test-123",
        port: 3000,
        status: "Healthy",
      });

      const config = generateNginxConfig();
      const expectedShortId = String(testProject.id).replace(/[^a-z0-9]/gi, "").slice(0, 12).toLowerCase();
      assert.ok(config.includes(`upstream upstream_df_${expectedShortId}_3000`));
      assert.ok(config.includes("server df-dep-test-123:3000"));
      assert.ok(config.includes("server_name test-app.internal;"));
      assert.ok(config.includes(`proxy_pass http://upstream_df_${expectedShortId}_3000;`));
    });

    it("synchronizes generated config to disk", async () => {
      const syncResult = await syncNginxConfig();
      assert.equal(syncResult.synced, true);
      assert.ok(fs.existsSync(UPSTREAMS_CONF_FILE));
      assert.ok(fs.existsSync(INGRESS_CONF_FILE));

      const fileContent = fs.readFileSync(UPSTREAMS_CONF_FILE, "utf-8");
      assert.ok(fileContent.includes("test-app.internal"));
    });

    it("unregisters upstream and removes from generated config", async () => {
      unregisterUpstreamRoute("test-app.internal");
      const syncResult = await syncNginxConfig();
      assert.equal(syncResult.synced, true);

      const fileContent = fs.readFileSync(UPSTREAMS_CONF_FILE, "utf-8");
      assert.ok(!fileContent.includes("test-app.internal"));
    });
  });

  describe("5. End-to-End Worker Lifecycle & Resource Cleanup", () => {
    let deployment;

    it("processes deployment job through CLONING -> BUILDING -> STARTING -> RUNNING", async () => {
      const depRes = await pool.query(
        `INSERT INTO deployments (project_id, user_id, status, branch, commit_hash)
         VALUES ($1, $2, 'INITIATED', 'main', 'abcdef123456')
         RETURNING *`,
        [testProject.id, testUser.id]
      );
      deployment = depRes.rows[0];

      const jobData = {
        deployment_id: deployment.id,
        project_id: testProject.id,
        user_id: testUser.id,
        repo_url: testProject.repository_url,
        branch: "main",
        commit_hash: "abcdef123456",
        runtime: "node",
        port: 3000,
        domain: testProject.domain,
        project_name: testProject.name,
      };

      await processJob(jobData, "test-msg-001");

      // Verify PostgreSQL deployment status
      const verifyDep = await pool.query(`SELECT * FROM deployments WHERE id = $1`, [deployment.id]);
      assert.equal(verifyDep.rows[0].status.toUpperCase(), "RUNNING");
      assert.ok(verifyDep.rows[0].container_id);
      assert.ok(verifyDep.rows[0].container_id.startsWith("c_"));

      // Verify project status
      const verifyProj = await pool.query(`SELECT * FROM projects WHERE id = $1`, [testProject.id]);
      assert.equal(verifyProj.rows[0].status.toUpperCase(), "RUNNING");

      // Verify Redis hot state
      const hot = await getDeploymentHotState(deployment.id);
      assert.equal(hot.status, "RUNNING");
      assert.equal(hot.progress_pct, 100);

      // Verify Nginx routing table
      const routes = getRoutingTable();
      const matched = routes.find((r) => r.domain === testProject.domain.toLowerCase());
      assert.ok(matched, "Upstream route registered in proxy table");
    });
  });
});
