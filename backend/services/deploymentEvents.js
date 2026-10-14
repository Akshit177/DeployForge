const redis = require("../config/redis.js");

const EVENTS_STREAM = "stream:deployment_events";
const PERSISTENCE_GROUP = "deployforge_persistence";

let isGroupCreated = false;

/**
 * Ensure Redis Stream and consumer group exist for persistence worker
 */
async function ensurePersistenceGroup() {
  if (isGroupCreated) return;
  try {
    if (redis.status !== "ready" && redis.status !== "connecting") {
      await redis.connect().catch(() => {});
    }
    await redis.xgroup("CREATE", EVENTS_STREAM, PERSISTENCE_GROUP, "$", "MKSTREAM");
    isGroupCreated = true;
  } catch (err) {
    if (err.message.includes("BUSYGROUP")) {
      isGroupCreated = true;
    } else {
      console.warn("Could not create Redis persistence consumer group:", err.message);
    }
  }
}

/**
 * Publish a deployment event to the Redis deployment events stream
 * @param {string} eventType - e.g. STAGE_CHANGED, DEPLOYMENT_COMPLETED, DEPLOYMENT_FAILED
 * @param {object} payload - Event payload
 * @returns {Promise<string>} Redis stream message ID
 */
async function publishDeploymentEvent(eventType, payload) {
  await ensurePersistenceGroup();

  try {
    const messageId = await redis.xadd(
      EVENTS_STREAM,
      "*",
      "event_type",
      eventType,
      "aggregate_id",
      payload.deployment_id || "",
      "payload",
      JSON.stringify(payload),
      "created_at",
      new Date().toISOString()
    );
    return messageId;
  } catch (error) {
    console.warn("Failed to publish deployment event to Redis:", error.message);
    return `local-event-${Date.now()}`;
  }
}

/**
 * Get metrics for the deployment events stream
 */
async function getEventsMetrics() {
  try {
    if (redis.status !== "ready" && redis.status !== "connecting") {
      await redis.connect().catch(() => {});
    }
    const length = await redis.xlen(EVENTS_STREAM);
    return {
      stream: EVENTS_STREAM,
      group: PERSISTENCE_GROUP,
      active_events: length,
      connected: redis.status === "ready",
    };
  } catch (err) {
    return {
      stream: EVENTS_STREAM,
      group: PERSISTENCE_GROUP,
      active_events: 0,
      connected: false,
      warning: err.message,
    };
  }
}

module.exports = {
  EVENTS_STREAM,
  PERSISTENCE_GROUP,
  ensurePersistenceGroup,
  publishDeploymentEvent,
  getEventsMetrics,
};
