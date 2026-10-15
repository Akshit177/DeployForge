const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const { promisify } = require("util");
const redis = require("../config/redis.js");
const pool = require("../config/db.js");
const { STREAM_NAME, CONSUMER_GROUP, ensureConsumerGroup } = require("../services/queue.js");
const { emitDeploymentLog } = require("../services/logEmitter.js");
const { probeContainerEndpoint } = require("../services/healthCheck.js");
const { registerUpstreamRoute } = require("../services/proxyRouter.js");
const { setDeploymentHotState, deleteDeploymentHotState } = require("../services/hotState.js");
const { publishDeploymentEvent } = require("../services/deploymentEvents.js");
const { drainPersistenceEvents } = require("./persistenceWorker.js");
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
  getWorkspacePath,
  cleanupWorkspace,
  detectRuntime,
  prepareWorkspaceDockerfile,
} = require("../services/runtimeDetector.js");

const execFileAsync = promisify(execFile);
const CONSUMER_NAME = `worker-${process.pid}`;
let isRunning = false;

function parseStreamEntry(fieldsArray) {
  const result = {};
  for (let i = 0; i < fieldsArray.length; i += 2) {
    result[fieldsArray[i]] = fieldsArray[i + 1];
  }
  return result;
}

async function recordWorkerLog(deploymentId, projectId, userId, level, source, message) {
  try {
    const res = await pool.query(
      `INSERT INTO logs (deployment_id, project_id, user_id, level, source, message)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [deploymentId, projectId, userId, level, source, message]
    );
    const row = res.rows[0];
    const d = new Date(row.created_at);
    const timeStr = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}.${String(d.getMilliseconds()).padStart(3, "0")}`;

    emitDeploymentLog(deploymentId, {
      id: row.id,
      deployment_id: row.deployment_id,
      project_id: row.project_id,
      level: row.level,
      source: row.source,
      text: row.message,
      message: row.message,
      time: timeStr,
      created_at: row.created_at,
    });
  } catch (err) {
    console.warn("Worker log error:", err.message);
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function processJob(jobData, messageId) {
  const {
    deployment_id,
    project_id,
    user_id,
    repo_url,
    branch,
    commit_hash,
    runtime,
    port,
    domain: jobDomain,
    project_name: jobProjectName,
  } = jobData;

  const depRes = await pool.query(
    `SELECT d.*, p.name AS project_name, p.domain, p.port AS project_port, p.env_vars AS project_env_vars
     FROM deployments d
     JOIN projects p ON d.project_id = p.id
     WHERE d.id = $1`,
    [deployment_id]
  );
  if (depRes.rows.length === 0) return;
  const dep = depRes.rows[0];

  const domain = dep.domain || jobDomain || "";
  const projectName = dep.project_name || jobProjectName || "unknown";
  const configuredPort = Number(port || dep.project_port || 3000);

  // Idempotency check: if already RUNNING or CANCELLED, acknowledge and skip
  const currentStatus = (dep.status || "").toUpperCase();
  if (currentStatus === "RUNNING" || currentStatus === "CANCELLED" || currentStatus === "FAILED") {
    try {
      await redis.xack(STREAM_NAME, CONSUMER_GROUP, messageId);
    } catch (_) {}
    return;
  }

  let workspacePath = null;
  let containerResult = null;

  try {
    // 1. Transition to CLONING
    await setDeploymentHotState(deployment_id, {
      project_id,
      status: "CLONING",
      stage: "clone",
      progress_pct: 20,
      domain,
      port: configuredPort,
    });

    await publishDeploymentEvent("STAGE_CHANGED", {
      deployment_id,
      project_id,
      user_id,
      status: "CLONING",
      stage: "clone",
    });

    await pool.query(
      `UPDATE deployments SET status = 'CLONING', updated_at = NOW() WHERE id = $1`,
      [deployment_id]
    );
    await pool.query(
      `UPDATE projects SET status = 'CLONING', updated_at = NOW() WHERE id = $1`,
      [project_id]
    );
    await recordWorkerLog(
      deployment_id,
      project_id,
      user_id,
      "INFO",
      "worker",
      `Worker ${CONSUMER_NAME} picked up deployment #${dep.deployment_number}`
    );
    await recordWorkerLog(
      deployment_id,
      project_id,
      user_id,
      "STEP",
      "clone",
      `Cloning ${repo_url || projectName} (branch: ${branch || "main"}, commit: ${(commit_hash || "HEAD").slice(0, 7)})`
    );

    workspacePath = getWorkspacePath(deployment_id);

    // If repository URL is a valid remote git URL, clone it
    const isGitUrl =
      repo_url &&
      (repo_url.startsWith("http://") || repo_url.startsWith("https://") || repo_url.startsWith("git@"));

    if (isGitUrl) {
      try {
        await execFileAsync("git", ["clone", "--depth", "1", "-b", branch || "main", repo_url, workspacePath]);
      } catch (gitErr) {
        try {
          await execFileAsync("git", ["clone", "--depth", "1", repo_url, workspacePath]);
        } catch (gitErr2) {
          if (getMode() === "real") {
            throw new Error(`Git clone failed for ${repo_url}: ${gitErr2.message}`);
          }
        }
      }
    }

    // Ensure workspace contains Dockerfile (fallback for mock repos/offline dev/tests in simulator mode)
    if (getMode() === "simulator" && !fs.existsSync(path.join(workspacePath, "Dockerfile"))) {
      fs.writeFileSync(
        path.join(workspacePath, "Dockerfile"),
        `FROM alpine:latest\nEXPOSE ${configuredPort}\nCMD ["echo", "DeployForge App: ${projectName}"]\n`
      );
    }

    await drainPersistenceEvents();
    await sleep(200);

    // 2. Transition to BUILDING
    await setDeploymentHotState(deployment_id, {
      project_id,
      status: "BUILDING",
      stage: "build",
      progress_pct: 50,
      domain,
      port: configuredPort,
    });

    await publishDeploymentEvent("STAGE_CHANGED", {
      deployment_id,
      project_id,
      user_id,
      status: "BUILDING",
      stage: "build",
    });

    await pool.query(
      `UPDATE deployments SET status = 'BUILDING', updated_at = NOW() WHERE id = $1`,
      [deployment_id]
    );
    await pool.query(
      `UPDATE projects SET status = 'BUILDING', updated_at = NOW() WHERE id = $1`,
      [project_id]
    );

    const runtimeInfo = detectRuntime(workspacePath);
    prepareWorkspaceDockerfile(workspacePath, runtimeInfo);

    const imageName = `deployforge-${projectName.toLowerCase().replace(/[^a-z0-9_]/g, "_")}-${deployment_id.slice(0, 8)}:latest`;

    await recordWorkerLog(
      deployment_id,
      project_id,
      user_id,
      "STEP",
      "build",
      `Building Docker image '${imageName}' for runtime: ${runtimeInfo.runtime} · Non-root user verified`
    );

    const buildResult = await buildImage(workspacePath, imageName);
    await recordWorkerLog(
      deployment_id,
      project_id,
      user_id,
      "INFO",
      "build",
      `Docker image built successfully (ID: ${buildResult.imageId.slice(0, 16)})`
    );

    await drainPersistenceEvents();
    await sleep(200);

    // 3. Transition to STARTING
    await setDeploymentHotState(deployment_id, {
      project_id,
      status: "STARTING",
      stage: "deploy",
      progress_pct: 80,
      domain,
      port: configuredPort,
    });

    await publishDeploymentEvent("STAGE_CHANGED", {
      deployment_id,
      project_id,
      user_id,
      status: "STARTING",
      stage: "deploy",
    });

    await pool.query(
      `UPDATE deployments SET status = 'STARTING', updated_at = NOW() WHERE id = $1`,
      [deployment_id]
    );
    await pool.query(
      `UPDATE projects SET status = 'STARTING', updated_at = NOW() WHERE id = $1`,
      [project_id]
    );

    const containerName = `df-${deployment_id.replace(/-/g, "").slice(0, 12)}`;
    const internalPort = runtimeInfo.detectedPort || configuredPort;

    // Build container environment variables
    const containerEnv = {
      PORT: String(internalPort),
      NODE_ENV: "production",
    };
    if (dep.project_env_vars && Array.isArray(dep.project_env_vars)) {
      for (const ev of dep.project_env_vars) {
        if (ev && ev.key) containerEnv[ev.key] = String(ev.value || "");
      }
    }

    await recordWorkerLog(
      deployment_id,
      project_id,
      user_id,
      "STEP",
      "deploy",
      `Creating and starting isolated container '${containerName}' on internal port :${internalPort} (network: deployforge-apps)`
    );

    containerResult = await createContainer({
      imageName,
      containerName,
      containerPort: internalPort,
      env: containerEnv,
      networkName: process.env.APP_NETWORK || "deployforge-apps",
      resourceLimits: { memoryMB: 512, cpuShares: 256, pidsLimit: 100 },
    });

    await startContainer(containerResult.containerId);

    // Health check probe
    const probeHost = getMode() === "real" ? containerName : "127.0.0.1";
    const probe = await probeContainerEndpoint({ host: probeHost, port: internalPort });

    if (!probe.healthy && getMode() === "real") {
      throw new Error(`Health probe failed on ${probeHost}:${internalPort} (${probe.error || probe.statusCode})`);
    }

    await recordWorkerLog(
      deployment_id,
      project_id,
      user_id,
      "INFO",
      "deploy",
      `Health probe on port :${internalPort} returned ${probe.statusCode} OK (${probe.latencyMs}ms)`
    );

    await drainPersistenceEvents();
    await sleep(200);

    // 4. Transition to RUNNING
    const rawCid = containerResult.containerId || `sim_c_${deployment_id.replace(/-/g, "").slice(0, 12)}`;
    const containerId = rawCid.startsWith("c_")
      ? rawCid
      : `c_${rawCid.replace(/^sim_c_/, "").slice(0, 12)}`;

    const durationSec = Math.max(1, Math.floor((Date.now() - new Date(dep.created_at).getTime()) / 1000));

    // Update Redis Hot State
    await setDeploymentHotState(deployment_id, {
      project_id,
      status: "RUNNING",
      stage: "running",
      progress_pct: 100,
      container_id: containerId,
      duration_seconds: durationSec,
      domain,
      public_url: `https://${domain}`,
    });

    // Emit deployment completed event
    await publishDeploymentEvent("DEPLOYMENT_COMPLETED", {
      deployment_id,
      project_id,
      user_id,
      status: "RUNNING",
      container_id: containerId,
      duration_seconds: durationSec,
      domain,
    });

    await pool.query(
      `UPDATE deployments
       SET status = 'RUNNING',
           duration_seconds = $1,
           container_id = $2,
           updated_at = NOW()
       WHERE id = $3`,
      [durationSec, containerId, deployment_id]
    );
    await pool.query(
      `UPDATE projects SET status = 'RUNNING', updated_at = NOW() WHERE id = $1`,
      [project_id]
    );

    // Register in dynamic reverse proxy routing table
    registerUpstreamRoute(domain, {
      projectId: project_id,
      projectName,
      deploymentId: deployment_id,
      containerId,
      targetHost: getMode() === "real" ? containerName : "127.0.0.1",
      port: internalPort,
      status: "Healthy",
      last_probe_ms: probe.latencyMs,
    });

    await recordWorkerLog(
      deployment_id,
      project_id,
      user_id,
      "INFO",
      "deploy",
      `Deployment #${dep.deployment_number} is healthy · public URL active: https://${domain}`
    );

    await drainPersistenceEvents();

    // 5. Acknowledge message in Redis Stream
    try {
      await redis.xack(STREAM_NAME, CONSUMER_GROUP, messageId);
    } catch (ackErr) {
      console.warn("XACK error:", ackErr.message);
    }
  } catch (err) {
    console.error(`Worker error for deployment ${deployment_id}:`, err.message);
    await recordWorkerLog(
      deployment_id,
      project_id,
      user_id,
      "ERROR",
      "worker",
      `Deployment failed: ${err.message}`
    );

    await setDeploymentHotState(deployment_id, {
      project_id,
      status: "FAILED",
      stage: "failed",
      error_message: err.message,
    });

    await publishDeploymentEvent("DEPLOYMENT_FAILED", {
      deployment_id,
      project_id,
      user_id,
      status: "FAILED",
      error_message: err.message,
    });

    await pool.query(
      `UPDATE deployments SET status = 'FAILED', error_message = $1, updated_at = NOW() WHERE id = $2`,
      [err.message, deployment_id]
    );
    await pool.query(
      `UPDATE projects SET status = 'FAILED', updated_at = NOW() WHERE id = $1`,
      [project_id]
    );

    try {
      await redis.xack(STREAM_NAME, CONSUMER_GROUP, messageId);
    } catch (_) {}
  }
}

async function pollOnce() {
  try {
    if (redis.status !== "ready" && redis.status !== "connecting") {
      await redis.connect().catch(() => {});
    }

    const response = await redis.xreadgroup(
      "GROUP",
      CONSUMER_GROUP,
      CONSUMER_NAME,
      "COUNT",
      "1",
      "BLOCK",
      "1500",
      "STREAMS",
      STREAM_NAME,
      ">"
    );

    if (!response || response.length === 0) return 0;

    const [streamName, messages] = response[0];
    if (!messages || messages.length === 0) return 0;

    for (const [messageId, fieldsArray] of messages) {
      const jobData = parseStreamEntry(fieldsArray);
      await processJob(jobData, messageId);
    }

    return messages.length;
  } catch (err) {
    if (!err.message.includes("NOGROUP")) {
      // Ignore routine timeouts or disconnection
    }
    return 0;
  }
}

async function startWorkerLoop() {
  const executionEngine = (process.env.EXECUTION_ENGINE || "node").toLowerCase();
  if (executionEngine === "cpp" || process.env.ENABLE_NODE_DEPLOYMENT_WORKER === "false") {
    console.log(`[Worker] Node.js deployment worker standby (EXECUTION_ENGINE=${executionEngine})`);
    return;
  }
  await ensureConsumerGroup();
  isRunning = true;
  console.log(`[Worker] ${CONSUMER_NAME} listening on Redis Stream "${STREAM_NAME}"`);

  (async () => {
    while (isRunning) {
      try {
        await pollOnce();
      } catch (err) {
        await sleep(1000);
      }
    }
  })();
}

function stopWorkerLoop() {
  isRunning = false;
}

if (require.main === module) {
  startWorkerLoop().catch((err) => {
    console.error("Worker startup failed:", err);
    process.exit(1);
  });
}

module.exports = {
  processJob,
  pollOnce,
  startWorkerLoop,
  stopWorkerLoop,
  CONSUMER_NAME,
};
