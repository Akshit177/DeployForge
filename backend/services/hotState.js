const redis = require("../config/redis.js");

const HOT_STATE_PREFIX = "deployment:";
const DEFAULT_HOT_STATE_TTL_SECONDS = 86400; // 24 hours

/**
 * Format key for hot deployment state
 */
function hotStateKey(deploymentId) {
  return `${HOT_STATE_PREFIX}${deploymentId}:state`;
}

/**
 * Record or update rapid deployment hot state in Redis
 * @param {string} deploymentId - UUID of deployment
 * @param {object} state - Status, stage, metrics, container info
 * @param {number} [ttlSeconds] - TTL in seconds
 * @returns {Promise<boolean>}
 */
async function setDeploymentHotState(deploymentId, state, ttlSeconds = DEFAULT_HOT_STATE_TTL_SECONDS) {
  if (!deploymentId) return false;
  const key = hotStateKey(deploymentId);

  const payload = {
    ...state,
    deployment_id: deploymentId,
    updated_at: new Date().toISOString(),
  };

  const fields = {};
  for (const [k, v] of Object.entries(payload)) {
    if (v !== undefined && v !== null) {
      fields[k] = typeof v === "object" ? JSON.stringify(v) : String(v);
    }
  }

  try {
    if (redis.status !== "ready" && redis.status !== "connecting") {
      await redis.connect().catch(() => {});
    }
    await redis.hset(key, fields);
    await redis.expire(key, ttlSeconds);
    return true;
  } catch (error) {
    console.warn("Failed to set deployment hot state in Redis:", error.message);
    return false;
  }
}

/**
 * Retrieve hot deployment state from Redis
 * @param {string} deploymentId - UUID of deployment
 * @returns {Promise<object|null>}
 */
async function getDeploymentHotState(deploymentId) {
  if (!deploymentId) return null;
  const key = hotStateKey(deploymentId);

  try {
    if (redis.status !== "ready" && redis.status !== "connecting") {
      await redis.connect().catch(() => {});
    }
    const raw = await redis.hgetall(key);
    if (!raw || Object.keys(raw).length === 0) return null;

    return {
      deployment_id: raw.deployment_id || deploymentId,
      project_id: raw.project_id || null,
      status: raw.status || "UNKNOWN",
      stage: raw.stage || null,
      progress_pct: raw.progress_pct ? Number.parseInt(raw.progress_pct, 10) : 0,
      container_id: raw.container_id || null,
      port: raw.port ? Number.parseInt(raw.port, 10) : 3000,
      domain: raw.domain || null,
      public_url: raw.public_url || null,
      duration_seconds: raw.duration_seconds ? Number.parseInt(raw.duration_seconds, 10) : 0,
      error_message: raw.error_message || null,
      updated_at: raw.updated_at || null,
    };
  } catch (error) {
    console.warn("Failed to get deployment hot state from Redis:", error.message);
    return null;
  }
}

/**
 * Remove deployment hot state from Redis
 * @param {string} deploymentId
 */
async function deleteDeploymentHotState(deploymentId) {
  if (!deploymentId) return false;
  const key = hotStateKey(deploymentId);

  try {
    if (redis.status !== "ready" && redis.status !== "connecting") {
      await redis.connect().catch(() => {});
    }
    const res = await redis.del(key);
    return res > 0;
  } catch (error) {
    console.warn("Failed to delete deployment hot state from Redis:", error.message);
    return false;
  }
}

module.exports = {
  HOT_STATE_PREFIX,
  DEFAULT_HOT_STATE_TTL_SECONDS,
  setDeploymentHotState,
  getDeploymentHotState,
  deleteDeploymentHotState,
};
