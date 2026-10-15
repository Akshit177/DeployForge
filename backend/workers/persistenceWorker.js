const pool = require("../config/db.js");
const redis = require("../config/redis.js");
const {
  EVENTS_STREAM,
  EVENTS_DLQ_STREAM,
  PERSISTENCE_GROUP,
  ensurePersistenceGroup,
} = require("../services/deploymentEvents.js");
const {
  registerUpstreamRoute,
  unregisterUpstreamRoute,
} = require("../services/proxyRouter.js");

const CONSUMER_NAME = `persistence-${process.pid}`;
let isLoopRunning = false;
let loopTimer = null;
let activeDrainPromise = null;

function parseStreamEntry(fieldsArray) {
  const result = {};
  for (let i = 0; i < fieldsArray.length; i += 2) {
    result[fieldsArray[i]] = fieldsArray[i + 1];
  }
  return result;
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isValidUuid = (val) => typeof val === "string" && UUID_REGEX.test(val);

/**
 * Apply event state change inside an atomic PostgreSQL transaction
 * @param {object} client - pg pool client with open transaction
 * @param {string} eventType
 * @param {object} payload
 */
async function applyEventTransaction(client, eventType, payload) {
  const {
    deployment_id,
    project_id,
    user_id,
    status,
    container_id,
    container_name,
    duration_seconds,
    error_message,
    domain,
    port,
    project_name,
    log,
  } = payload;

  const validDepId = isValidUuid(deployment_id) ? deployment_id : null;
  const validProjId = isValidUuid(project_id) ? project_id : null;
  const validUserId = isValidUuid(user_id) ? user_id : null;

  let activeProjId = validProjId;
  if (!activeProjId && validDepId) {
    const depRow = await client.query("SELECT project_id FROM deployments WHERE id = $1", [validDepId]);
    if (depRow.rows.length > 0 && isValidUuid(depRow.rows[0].project_id)) {
      activeProjId = depRow.rows[0].project_id;
    }
  }

  const depContainerName = container_name || (validDepId ? `df-${validDepId.replace(/-/g, "").slice(0, 12)}` : null);

  switch (eventType) {
    case "STAGE_CHANGED": {
      if (validDepId && status) {
        await client.query(
          `UPDATE deployments SET status = $1, updated_at = NOW() WHERE id = $2`,
          [status, validDepId]
        );
      }
      if (activeProjId && status) {
        await client.query(
          `UPDATE projects SET status = $1, updated_at = NOW() WHERE id = $2`,
          [status, activeProjId]
        );
      }
      break;
    }

    case "DEPLOYMENT_COMPLETED": {
      if (validDepId) {
        await client.query(
          `UPDATE deployments
           SET status = 'RUNNING',
               duration_seconds = COALESCE($1, duration_seconds),
               container_id = COALESCE($2, container_id),
               container_name = COALESCE($3, container_name),
               updated_at = NOW()
           WHERE id = $4`,
          [duration_seconds || 0, container_id || null, depContainerName, validDepId]
        );
      }
      if (activeProjId) {
        const projRes = await client.query(
          `UPDATE projects SET status = 'RUNNING', updated_at = NOW() WHERE id = $1
           RETURNING id, name, domain, port`,
          [activeProjId]
        );
        const proj = projRes.rows[0];
        const routeDomain = domain || (proj && proj.domain);
        if (routeDomain) {
          const routePort = port || (proj && proj.port) || 3000;
          const routeProjName = project_name || (proj && proj.name) || "app";
          const targetHost = depContainerName || "127.0.0.1";
          registerUpstreamRoute(routeDomain, {
            projectId: activeProjId,
            projectName: routeProjName,
            deploymentId: validDepId,
            containerId: container_id || (validDepId ? `c_${validDepId.replace(/-/g, "").slice(0, 12)}` : null),
            containerName: depContainerName,
            targetHost: targetHost,
            port: routePort,
            status: "Healthy",
          });
        }
      }
      break;
    }

    case "DEPLOYMENT_FAILED": {
      if (validDepId) {
        await client.query(
          `UPDATE deployments
           SET status = 'FAILED',
               error_message = $1,
               updated_at = NOW()
           WHERE id = $2`,
          [error_message || "Deployment failed", validDepId]
        );
      }
      if (activeProjId) {
        const projRes = await client.query(
          `UPDATE projects SET status = 'Failed', updated_at = NOW() WHERE id = $1 RETURNING domain`,
          [activeProjId]
        );
        const unregDomain = domain || (projRes.rows[0] && projRes.rows[0].domain);
        if (unregDomain) {
          unregisterUpstreamRoute(unregDomain);
        }
      }
      break;
    }

    case "DEPLOYMENT_CANCELLED": {
      if (validDepId) {
        await client.query(
          `UPDATE deployments
           SET status = 'Cancelled',
               error_message = 'Deployment cancelled by user.',
               updated_at = NOW()
           WHERE id = $1`,
          [validDepId]
        );
      }
      if (activeProjId) {
        const projRes = await client.query(
          `UPDATE projects SET status = 'Stopped', updated_at = NOW() WHERE id = $1 RETURNING domain`,
          [activeProjId]
        );
        const unregDomain = domain || (projRes.rows[0] && projRes.rows[0].domain);
        if (unregDomain) {
          unregisterUpstreamRoute(unregDomain);
        }
      }
      break;
    }

    case "LOG_EMITTED":
    default:
      break;
  }

  // Insert log row if attached to event
  if (log && validDepId && validProjId && validUserId) {
    await client.query(
      `INSERT INTO logs (deployment_id, project_id, user_id, level, source, message)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        validDepId,
        validProjId,
        validUserId,
        log.level || "INFO",
        log.source || "worker",
        log.message || log.text || "",
      ]
    );
  }
}

/**
 * Route invalid or poisoned event to DLQ stream and log reason
 */
async function routeToDlq(messageId, eventType, rawEntry, reason) {
  try {
    if (redis.status !== "ready" && redis.status !== "connecting") {
      await redis.connect().catch(() => {});
    }
    await redis.xadd(
      EVENTS_DLQ_STREAM,
      "*",
      "original_message_id",
      String(messageId || ""),
      "event_type",
      String(eventType || ""),
      "reason",
      String(reason || "Missing or invalid payload"),
      "raw_entry",
      typeof rawEntry === "string" ? rawEntry : JSON.stringify(rawEntry || {}),
      "failed_at",
      new Date().toISOString()
    );
  } catch (err) {
    console.warn(`[Persistence Worker] Failed to write event ${messageId} to DLQ:`, err.message);
  }
}

/**
 * Process a single event message with guaranteed atomic persistence:
 * Read Redis event → PostgreSQL update in transaction → COMMIT → ACK Redis event
 */
async function processEvent(messageId, eventType, rawPayload, fullEntry = null) {
  if (!rawPayload) {
    console.warn(
      `[Persistence Worker] Malformed event ${messageId} (${eventType}): missing 'payload' envelope field. Routing to DLQ.`
    );
    await routeToDlq(messageId, eventType, fullEntry, "Missing 'payload' field");
    await redis.xack(EVENTS_STREAM, PERSISTENCE_GROUP, messageId).catch(() => {});
    return false;
  }

  let payload;
  try {
    payload = typeof rawPayload === "string" ? JSON.parse(rawPayload) : rawPayload;
    if (!payload || typeof payload !== "object") {
      throw new Error("Payload must be a non-null object");
    }
  } catch (parseErr) {
    console.error(`Invalid JSON payload for event ${messageId}:`, parseErr.message);
    await routeToDlq(
      messageId,
      eventType,
      fullEntry || rawPayload,
      `Invalid JSON payload: ${parseErr.message}`
    );
    // Bad message format - acknowledge to avoid blocking queue
    await redis.xack(EVENTS_STREAM, PERSISTENCE_GROUP, messageId).catch(() => {});
    return false;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await applyEventTransaction(client, eventType, payload);
    await client.query("COMMIT");

    // ACK Redis event ONLY AFTER durable PostgreSQL transaction commits
    await redis.xack(EVENTS_STREAM, PERSISTENCE_GROUP, messageId);
    return true;
  } catch (dbErr) {
    await client.query("ROLLBACK").catch(() => {});
    console.warn(`[Persistence Worker] Commit failed for event ${messageId}, leaving un-ACKed in Redis PEL:`, dbErr.message);
    // Message remains unacknowledged in Redis PEL for retry
    return false;
  } finally {
    client.release();
  }
}

/**
 * Poll deployment event stream once
 * Reads new events ('>') and any pending unacknowledged events from PEL
 * @param {number} [count]
 * @returns {Promise<number>} Processed event count
 */
async function pollPersistenceEvents(count = 10) {
  await ensurePersistenceGroup();

  try {
    if (redis.status !== "ready" && redis.status !== "connecting") {
      await redis.connect().catch(() => {});
    }

    let processedTotal = 0;

    // 1. Process new messages
    const response = await redis.xreadgroup(
      "GROUP",
      PERSISTENCE_GROUP,
      CONSUMER_NAME,
      "COUNT",
      String(count),
      "STREAMS",
      EVENTS_STREAM,
      ">"
    );

    if (response && response.length > 0) {
      const [, messages] = response[0];
      if (messages && messages.length > 0) {
        for (const [messageId, fieldsArray] of messages) {
          const entry = parseStreamEntry(fieldsArray);
          const success = await processEvent(messageId, entry.event_type, entry.payload, entry);
          if (success) processedTotal++;
        }
      }
    }

    return processedTotal;
  } catch (error) {
    if (!error.message.includes("NOGROUP")) {
      console.warn("Persistence worker polling error:", error.message);
    }
    return 0;
  }
}

/**
 * Drain all pending persistence events until the stream is caught up
 */
async function drainPersistenceEvents() {
  if (activeDrainPromise) {
    return activeDrainPromise;
  }

  activeDrainPromise = (async () => {
    let total = 0;
    let batchCount = 0;
    while (batchCount < 20) {
      const processed = await pollPersistenceEvents(10);
      total += processed;
      if (processed === 0) break;
      batchCount++;
    }
    return total;
  })().finally(() => {
    activeDrainPromise = null;
  });

  return activeDrainPromise;
}

/**
 * Start background persistence worker loop
 */
function startPersistenceWorkerLoop(intervalMs = 300) {
  if (isLoopRunning) return;
  isLoopRunning = true;

  async function loop() {
    if (!isLoopRunning) return;
    try {
      await pollPersistenceEvents(10);
    } catch (_) {}
    if (isLoopRunning) {
      loopTimer = setTimeout(loop, intervalMs);
    }
  }

  loop();
  console.log(`[Persistence Worker] Background event loop started (${intervalMs}ms interval)`);
}

/**
 * Stop background persistence worker loop
 */
function stopPersistenceWorkerLoop() {
  isLoopRunning = false;
  if (loopTimer) {
    clearTimeout(loopTimer);
    loopTimer = null;
  }
}

// Standalone CLI execution
if (require.main === module) {
  console.log("Starting DeployForge Dedicated Persistence Worker...");
  startPersistenceWorkerLoop(200);

  const shutdown = () => {
    console.log("Stopping Persistence Worker...");
    stopPersistenceWorkerLoop();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

module.exports = {
  CONSUMER_NAME,
  EVENTS_DLQ_STREAM,
  routeToDlq,
  processEvent,
  pollPersistenceEvents,
  drainPersistenceEvents,
  startPersistenceWorkerLoop,
  stopPersistenceWorkerLoop,
};
