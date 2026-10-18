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
const {
  canTransition,
  getAllowedPreviousStatuses,
  normalizeStatus,
} = require("../services/statusMachine.js");
const { emitDeploymentLog } = require("../services/logEmitter.js");
const { stopContainer, removeContainer, resolveContainerTarget } = require("../services/dockerClient.js");
const { deleteDeploymentHotState } = require("../services/hotState.js");

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
  const superseded = []; // previously RUNNING deployments replaced by this event
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
    commit_hash,
    commit_message,
    log,
  } = payload;

  const cleanCommitHash =
    commit_hash && commit_hash !== "HEAD" && String(commit_hash).trim()
      ? String(commit_hash).trim().slice(0, 40)
      : null;
  const cleanCommitMessage =
    commit_message && String(commit_message).trim()
      ? String(commit_message).trim()
      : null;

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
      const targetStatus = normalizeStatus(status);
      const allowedFrom = getAllowedPreviousStatuses(targetStatus);
      if (validDepId && targetStatus) {
        const depRes = await client.query(
          `UPDATE deployments
           SET status = $1,
               commit_hash = COALESCE($2, commit_hash),
               commit_message = COALESCE($3, commit_message),
               updated_at = NOW()
           WHERE id = $4 AND status = ANY($5::varchar[])
           RETURNING id, status`,
          [targetStatus, cleanCommitHash, cleanCommitMessage, validDepId, allowedFrom]
        );
        if (depRes.rows.length === 0) {
          console.warn(`[Persistence Worker] STAGE_CHANGED ignored for deployment ${validDepId}: transition to ${targetStatus} not allowed from current status`);
          break;
        }
      }
      if (activeProjId && targetStatus) {
        await client.query(
          `UPDATE projects SET status = $1, updated_at = NOW() WHERE id = $2`,
          [targetStatus, activeProjId]
        );
      }
      break;
    }

    case "DEPLOYMENT_COMPLETED": {
      const targetStatus = "RUNNING";
      const allowedFrom = getAllowedPreviousStatuses(targetStatus);
      if (validDepId) {
        const depRes = await client.query(
          `UPDATE deployments
           SET status = 'RUNNING',
               duration_seconds = COALESCE($1, duration_seconds),
               container_id = COALESCE($2, container_id),
               container_name = COALESCE($3, container_name),
               commit_hash = COALESCE($4, commit_hash),
               commit_message = COALESCE($5, commit_message),
               updated_at = NOW()
           WHERE id = $6 AND status = ANY($7::varchar[])
           RETURNING id, status`,
          [duration_seconds || 0, container_id || null, depContainerName, cleanCommitHash, cleanCommitMessage, validDepId, allowedFrom]
        );
        if (depRes.rows.length === 0) {
          console.warn(`[Persistence Worker] DEPLOYMENT_COMPLETED ignored for deployment ${validDepId}: transition to RUNNING not allowed from current status`);
          break;
        }
      }
      if (activeProjId) {
        const projRes = await client.query(
          `UPDATE projects
           SET status = 'RUNNING',
               latest_commit = COALESCE($1, latest_commit),
               updated_at = NOW()
           WHERE id = $2
           RETURNING id, name, domain, port`,
          [cleanCommitHash, activeProjId]
        );
        const proj = projRes.rows[0];

        // A new deployment going live supersedes the project's previous RUNNING deployments.
        // Without this every redeploy leaked a running container and left a stale RUNNING row
        // (which, after an API restart, could even win the routing table).
        if (validDepId) {
          const supersededRes = await client.query(
            `UPDATE deployments
             SET status = 'STOPPED', updated_at = NOW()
             WHERE project_id = $1 AND id <> $2 AND UPPER(status) = 'RUNNING'
             RETURNING id, container_id, container_name`,
            [activeProjId, validDepId]
          );
          superseded.push(...supersededRes.rows);
        }

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
      const targetStatus = "FAILED";
      const allowedFrom = getAllowedPreviousStatuses(targetStatus);
      if (validDepId) {
        const depRes = await client.query(
          `UPDATE deployments
           SET status = 'FAILED',
               error_message = $1,
               updated_at = NOW()
           WHERE id = $2 AND status = ANY($3::varchar[])
           RETURNING id, status`,
          [error_message || "Deployment failed", validDepId, allowedFrom]
        );
        if (depRes.rows.length === 0) {
          console.warn(`[Persistence Worker] DEPLOYMENT_FAILED ignored for deployment ${validDepId}: transition to FAILED not allowed from current status`);
          break;
        }
      }
      if (activeProjId) {
        const projRes = await client.query(
          // A failed (re)deploy must not mark the project FAILED, or unroute it, while a previous
          // deployment is still healthy and serving traffic.
          `UPDATE projects
           SET status = CASE
                 WHEN EXISTS (SELECT 1 FROM deployments WHERE project_id = $1 AND UPPER(status) = 'RUNNING')
                 THEN 'RUNNING' ELSE 'FAILED' END,
               updated_at = NOW()
           WHERE id = $1 RETURNING domain`,
          [activeProjId]
        );
        const unregDomain = domain || (projRes.rows[0] && projRes.rows[0].domain);
        if (unregDomain) {
          // Only drop the route if it is actually served by the deployment that failed
          unregisterUpstreamRoute(unregDomain, validDepId ? { deploymentId: validDepId } : {});
        }
      }
      break;
    }

    case "DEPLOYMENT_CANCELLED": {
      const targetStatus = "CANCELLED";
      const allowedFrom = getAllowedPreviousStatuses(targetStatus);
      if (validDepId) {
        const depRes = await client.query(
          `UPDATE deployments
           SET status = 'CANCELLED',
               error_message = 'Deployment cancelled by user.',
               updated_at = NOW()
           WHERE id = $1 AND status = ANY($2::varchar[])
           RETURNING id, status`,
          [validDepId, allowedFrom]
        );
        if (depRes.rows.length === 0) {
          console.warn(`[Persistence Worker] DEPLOYMENT_CANCELLED ignored for deployment ${validDepId}: transition to CANCELLED not allowed from current status`);
          break;
        }
      }
      if (activeProjId) {
        const projRes = await client.query(
          `UPDATE projects
           SET status = CASE
                 WHEN EXISTS (SELECT 1 FROM deployments WHERE project_id = $1 AND UPPER(status) = 'RUNNING')
                 THEN 'RUNNING' ELSE 'STOPPED' END,
               updated_at = NOW()
           WHERE id = $1 RETURNING domain`,
          [activeProjId]
        );
        const unregDomain = domain || (projRes.rows[0] && projRes.rows[0].domain);
        if (unregDomain) {
          unregisterUpstreamRoute(unregDomain, validDepId ? { deploymentId: validDepId } : {});
        }
      }
      break;
    }

    case "LOG_EMITTED":
    default:
      break;
  }

  const insertedLogs = [];

  let logData = null;
  if (eventType === "LOG_EMITTED") {
    logData = log || {
      level: payload.level,
      source: payload.source,
      message: payload.message || payload.text,
    };
  } else if (log) {
    logData = log;
  }

  if (logData && validDepId) {
    let logProjId = activeProjId;
    let logUserId = validUserId;
    if (!logProjId || !logUserId) {
      const depRow = await client.query("SELECT project_id, user_id FROM deployments WHERE id = $1", [validDepId]);
      if (depRow.rows.length > 0) {
        if (!logProjId && isValidUuid(depRow.rows[0].project_id)) logProjId = depRow.rows[0].project_id;
        if (!logUserId && isValidUuid(depRow.rows[0].user_id)) logUserId = depRow.rows[0].user_id;
      }
    }

    if (logProjId && logUserId) {
      const logRes = await client.query(
        `INSERT INTO logs (deployment_id, project_id, user_id, level, source, message)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING *`,
        [
          validDepId,
          logProjId,
          logUserId,
          String(logData.level || "INFO").toUpperCase(),
          String(logData.source || "worker").slice(0, 50),
          String(logData.message || logData.text || ""),
        ]
      );
      if (logRes.rows.length > 0) {
        insertedLogs.push(logRes.rows[0]);
      }
    }
  }

  return { insertedLogs, superseded };
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
    const { insertedLogs, superseded } = await applyEventTransaction(client, eventType, payload);
    await client.query("COMMIT");

    // ACK Redis event ONLY AFTER durable PostgreSQL transaction commits
    try {
      if (messageId) {
        await redis.xack(EVENTS_STREAM, PERSISTENCE_GROUP, messageId);
      }
    } catch (ackErr) {
      if (ackErr.message && ackErr.message.includes("NOGROUP")) {
        try {
          await ensurePersistenceGroup();
          await redis.xack(EVENTS_STREAM, PERSISTENCE_GROUP, messageId);
        } catch (_) {}
      } else {
        console.warn("XACK notice:", ackErr.message);
      }
    }

    // Tear down superseded containers in the background (docker stop can take seconds)
    if (superseded && superseded.length > 0) {
      for (const old of superseded) {
        const target = resolveContainerTarget({ ...old, deployment_id: old.id });
        if (target) {
          stopContainer(target, { expectedDeploymentId: old.id })
            .then(() => removeContainer(target, { expectedDeploymentId: old.id }))
            .catch(() => {});
        }
        deleteDeploymentHotState(old.id).catch(() => {});
      }
    }

    // Publish inserted logs to Redis pub/sub channels
    if (insertedLogs && insertedLogs.length > 0) {
      for (const logRow of insertedLogs) {
        const d = new Date(logRow.created_at);
        const timeStr = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}.${String(d.getMilliseconds()).padStart(3, "0")}`;
        const logPayload = {
          id: logRow.id,
          deployment_id: logRow.deployment_id,
          project_id: logRow.project_id,
          user_id: logRow.user_id,
          level: logRow.level,
          source: logRow.source,
          text: logRow.message,
          message: logRow.message,
          time: timeStr,
          created_at: logRow.created_at ? logRow.created_at.toISOString() : new Date().toISOString(),
          timestamp: logRow.created_at ? logRow.created_at.toISOString() : new Date().toISOString(),
        };

        if (redis.status === "ready" || redis.status === "connecting") {
          await redis.publish(`logs:${logPayload.deployment_id}`, JSON.stringify(logPayload)).catch(() => {});
          await redis.publish(`project:${logPayload.project_id}`, JSON.stringify(logPayload)).catch(() => {});
        }
        emitDeploymentLog(logPayload.deployment_id, logPayload);
      }
    }

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
// Pending (delivered-but-never-ACKed) events are re-claimed after this idle time. Without this a
// transient DB error, or a crash/restart (the consumer name embeds the pid) left the event in
// the PEL forever and the deployment stuck in a non-terminal state.
const RECLAIM_MIN_IDLE_MS = Number(process.env.PERSISTENCE_RECLAIM_IDLE_MS) || 30000;
// After this many delivery attempts the event is moved to the DLQ instead of retried again.
const MAX_DELIVERY_ATTEMPTS = Number(process.env.PERSISTENCE_MAX_DELIVERIES) || 5;

async function reclaimStaleEvents(count = 10) {
  let reply;
  try {
    reply = await redis.xautoclaim(
      EVENTS_STREAM,
      PERSISTENCE_GROUP,
      CONSUMER_NAME,
      RECLAIM_MIN_IDLE_MS,
      "0-0",
      "COUNT",
      String(count)
    );
  } catch (err) {
    if (err.message && err.message.includes("NOGROUP")) throw err;
    return 0; // e.g. Redis < 6.2 without XAUTOCLAIM: skip silently
  }

  const claimed = Array.isArray(reply) && Array.isArray(reply[1]) ? reply[1] : [];
  let processed = 0;

  for (const item of claimed) {
    const [messageId, fieldsArray] = item;
    if (!fieldsArray) {
      // Entry was trimmed from the stream; nothing left to process
      await redis.xack(EVENTS_STREAM, PERSISTENCE_GROUP, messageId).catch(() => {});
      continue;
    }

    const entry = parseStreamEntry(fieldsArray);

    let deliveries = 0;
    try {
      const pending = await redis.xpending(EVENTS_STREAM, PERSISTENCE_GROUP, messageId, messageId, 1);
      deliveries = Number(pending?.[0]?.[3]) || 0;
    } catch (_) {}

    if (deliveries > MAX_DELIVERY_ATTEMPTS) {
      console.error(`[Persistence Worker] Event ${messageId} failed ${deliveries} times; routing to DLQ.`);
      await routeToDlq(messageId, entry.event_type, entry, `Exceeded ${MAX_DELIVERY_ATTEMPTS} delivery attempts`);
      await redis.xack(EVENTS_STREAM, PERSISTENCE_GROUP, messageId).catch(() => {});
      continue;
    }

    if (await processEvent(messageId, entry.event_type, entry.payload, entry)) processed++;
  }

  return processed;
}

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

    // 2. Retry events that were delivered earlier but never ACKed
    processedTotal += await reclaimStaleEvents(count);

    return processedTotal;
  } catch (error) {
    if (error.message && error.message.includes("NOGROUP")) {
      // The group vanished (Redis lost its data): recreate it instead of failing forever
      await ensurePersistenceGroup(true).catch(() => {});
    } else {
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
