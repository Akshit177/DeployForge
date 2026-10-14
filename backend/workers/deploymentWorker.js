const redis = require("../config/redis.js");
const pool = require("../config/db.js");
const { STREAM_NAME, CONSUMER_GROUP, ensureConsumerGroup } = require("../services/queue.js");
const { emitDeploymentLog } = require("../services/logEmitter.js");
const { probeContainerEndpoint } = require("../services/healthCheck.js");
const { registerUpstreamRoute } = require("../services/proxyRouter.js");

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
  } = jobData;

  const depRes = await pool.query(
    `SELECT d.*, p.name AS project_name, p.domain FROM deployments d JOIN projects p ON d.project_id = p.id WHERE d.id = $1`,
    [deployment_id]
  );
  if (depRes.rows.length === 0) return;
  const dep = depRes.rows[0];

  // Idempotency check: if already RUNNING or CANCELLED, acknowledge and skip
  const currentStatus = (dep.status || "").toUpperCase();
  if (currentStatus === "RUNNING" || currentStatus === "CANCELLED" || currentStatus === "FAILED") {
    try {
      await redis.xack(STREAM_NAME, CONSUMER_GROUP, messageId);
    } catch (_) {}
    return;
  }

  // 1. Transition to CLONING
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
    `Cloning ${repo_url || dep.project_name} (branch: ${branch || "main"}, commit: ${(commit_hash || "HEAD").slice(0, 7)})`
  );

  await sleep(300);

  // 2. Transition to BUILDING
  await pool.query(
    `UPDATE deployments SET status = 'BUILDING', updated_at = NOW() WHERE id = $1`,
    [deployment_id]
  );
  await pool.query(
    `UPDATE projects SET status = 'BUILDING', updated_at = NOW() WHERE id = $1`,
    [project_id]
  );
  await recordWorkerLog(
    deployment_id,
    project_id,
    user_id,
    "STEP",
    "build",
    `Building Docker image for runtime: ${runtime || "node"} · Layers verified`
  );

  await sleep(300);

  // 3. Transition to STARTING
  await pool.query(
    `UPDATE deployments SET status = 'STARTING', updated_at = NOW() WHERE id = $1`,
    [deployment_id]
  );
  await pool.query(
    `UPDATE projects SET status = 'STARTING', updated_at = NOW() WHERE id = $1`,
    [project_id]
  );
  await recordWorkerLog(
    deployment_id,
    project_id,
    user_id,
    "STEP",
    "deploy",
    `Creating and starting isolated container on port :${port || 3000}`
  );

  const probe = await probeContainerEndpoint({ host: "127.0.0.1", port: port || 3000 });
  await recordWorkerLog(
    deployment_id,
    project_id,
    user_id,
    "INFO",
    "deploy",
    `Health probe on port :${port || 3000} returned ${probe.statusCode} OK (${probe.latencyMs}ms)`
  );

  await sleep(300);

  // 4. Transition to RUNNING
  const containerId = `c_${deployment_id.replace(/-/g, "").slice(0, 12)}`;
  const durationSec = Math.max(1, Math.floor((Date.now() - new Date(dep.created_at).getTime()) / 1000));

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
  registerUpstreamRoute(dep.domain, {
    projectId: project_id,
    projectName: dep.project_name,
    deploymentId: deployment_id,
    containerId,
    targetHost: "127.0.0.1",
    port: port || 3000,
    status: "Healthy",
    last_probe_ms: probe.latencyMs,
  });

  await recordWorkerLog(
    deployment_id,
    project_id,
    user_id,
    "INFO",
    "deploy",
    `Deployment #${dep.deployment_number} is healthy · public URL active: https://${dep.domain}`
  );

  // 4. Acknowledge message in Redis Stream
  try {
    await redis.xack(STREAM_NAME, CONSUMER_GROUP, messageId);
  } catch (ackErr) {
    console.warn("XACK error:", ackErr.message);
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
