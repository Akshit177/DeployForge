const redis = require("../config/redis.js");

const STREAM_NAME = "stream:deployments";
const CONSUMER_GROUP = "deployforge_workers";

let isGroupCreated = false;

async function ensureConsumerGroup() {
  if (isGroupCreated) return;
  try {
    if (redis.status !== "ready" && redis.status !== "connecting") {
      await redis.connect().catch(() => {});
    }
    await redis.xgroup("CREATE", STREAM_NAME, CONSUMER_GROUP, "$", "MKSTREAM");
    isGroupCreated = true;
  } catch (err) {
    if (err.message && err.message.includes("BUSYGROUP")) {
      isGroupCreated = true;
    } else {
      console.warn("Could not create Redis consumer group:", err.message);
      throw err;
    }
  }
}

/**
 * Publish a deployment job to the Redis Stream
 * @param {object} payload
 * @returns {Promise<string>} Redis stream message ID
 */
async function publishDeploymentJob(payload) {
  await ensureConsumerGroup();

  const fields = [
    "deployment_id", payload.deployment_id || "",
    "project_id", payload.project_id || "",
    "user_id", payload.user_id || "",
    "repo_url", payload.repo_url || payload.repository_url || "",
    "branch", payload.branch || "main",
    "commit_hash", payload.commit_hash || "HEAD",
    "runtime", payload.runtime || "node",
    "port", String(payload.port || 3000),
    "trigger", payload.trigger || "manual",
    "domain", payload.domain || payload.project_domain || "",
    "project_name", payload.project_name || payload.projectName || "",
    "created_at", new Date().toISOString(),
  ];

  return await redis.xadd(STREAM_NAME, "*", ...fields);
}

/**
 * Get current Redis Stream queue metrics
 */
async function getQueueMetrics() {
  try {
    if (redis.status !== "ready" && redis.status !== "connecting") {
      await redis.connect().catch(() => {});
    }
    const length = await redis.xlen(STREAM_NAME);
    return {
      stream: STREAM_NAME,
      group: CONSUMER_GROUP,
      active_jobs: length,
      connected: redis.status === "ready",
    };
  } catch (err) {
    return {
      stream: STREAM_NAME,
      group: CONSUMER_GROUP,
      active_jobs: 0,
      connected: false,
      warning: err.message,
    };
  }
}

module.exports = {
  STREAM_NAME,
  CONSUMER_GROUP,
  publishDeploymentJob,
  getQueueMetrics,
  ensureConsumerGroup,
};
