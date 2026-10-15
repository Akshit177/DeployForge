const pool = require("../config/db.js");
const queue = require("./queue.js");
const { recordWorkerLog } = require("./logEmitter.js");

const SWEEP_INTERVAL_MS = Number(process.env.OUTBOX_SWEEP_INTERVAL_MS || 3000);
const MAX_RETRIES = Number(process.env.OUTBOX_MAX_RETRIES || 5);
const REAPER_STUCK_MINUTES = Number(process.env.REAPER_STUCK_MINUTES || 10);

let sweepTimer = null;
let reaperTimer = null;
let activeRelayPromise = null;

/**
 * Drain pending outbox events and publish them to Redis Streams.
 * Uses SELECT ... FOR UPDATE SKIP LOCKED to ensure concurrency safety across multiple workers/nodes,
 * bounded retries to prevent poison-pill head-of-line blocking, and marks dead-letter events as FAILED.
 */
async function relayPendingEvents() {
  if (activeRelayPromise) {
    return activeRelayPromise;
  }

  activeRelayPromise = (async () => {
    const client = await pool.connect();
    let processedCount = 0;

    try {
      await client.query("BEGIN");

      // Fetch batch of pending outbox events locking rows to prevent duplicate concurrent publishing
      const selectRes = await client.query(
        `SELECT * FROM outbox_events
         WHERE status = 'PENDING'
           AND retry_count < $1
           AND (next_retry_at IS NULL OR next_retry_at <= NOW())
         ORDER BY created_at ASC
         LIMIT 50
         FOR UPDATE SKIP LOCKED`,
        [MAX_RETRIES]
      );

      const events = selectRes.rows;

      for (const event of events) {
        const payload = typeof event.payload === "string" ? JSON.parse(event.payload) : event.payload;

        try {
          // Publish deployment job to Redis Stream
          await queue.publishDeploymentJob(payload);

          // Mark outbox event as PROCESSED only after Redis accepts the event
          await client.query(
            `UPDATE outbox_events
             SET status = 'PROCESSED', processed_at = NOW(), error_message = NULL
             WHERE id = $1`,
            [event.id]
          );

          // Transition deployment from INITIATED to QUEUED
          if (event.aggregate_type === "DEPLOYMENT" && event.aggregate_id) {
            await client.query(
              `UPDATE deployments
               SET status = 'QUEUED', updated_at = NOW()
               WHERE id = $1 AND status = 'INITIATED'`,
              [event.aggregate_id]
            );

            if (payload.project_id) {
              await client.query(
                `UPDATE projects
                 SET status = 'QUEUED', updated_at = NOW()
                 WHERE id = $1 AND status = 'INITIATED'`,
                [payload.project_id]
              );
            }

            // Emit log indicating transition to QUEUED in Redis
            recordWorkerLog(
              event.aggregate_id,
              payload.project_id,
              payload.user_id,
              "INFO",
              "outbox",
              `Deployment queued via Transactional Outbox (Event ID: ${event.id.slice(0, 8)})`
            ).catch(() => {});
          }

          processedCount++;
        } catch (redisErr) {
          console.warn(`[OutboxRelay] Redis publish failed for event ${event.id}:`, redisErr.message);

          const nextRetry = (Number(event.retry_count) || 0) + 1;
          if (nextRetry >= MAX_RETRIES) {
            console.error(
              `[OutboxRelay] Event ${event.id} exceeded max retries (${MAX_RETRIES}). Transitioning to FAILED/DEAD_LETTER.`
            );
            await client.query(
              `UPDATE outbox_events
               SET retry_count = $1,
                   status = 'FAILED',
                   error_message = $2,
                   processed_at = NOW()
               WHERE id = $3`,
              [nextRetry, `Exceeded max retries (${MAX_RETRIES}): ${redisErr.message}`, event.id]
            );

            // Fail associated deployment and project if aggregate is DEPLOYMENT
            if (event.aggregate_type === "DEPLOYMENT" && event.aggregate_id) {
              await client.query(
                `UPDATE deployments
                 SET status = 'FAILED', error_message = $1, updated_at = NOW()
                 WHERE id = $2 AND status = 'INITIATED'`,
                [`Outbox delivery failed after ${MAX_RETRIES} attempts: ${redisErr.message}`, event.aggregate_id]
              );

              if (payload.project_id) {
                await client.query(
                  `UPDATE projects
                   SET status = 'Failed', updated_at = NOW()
                   WHERE id = $1 AND status = 'INITIATED'`,
                  [payload.project_id]
                );
              }

              recordWorkerLog(
                event.aggregate_id,
                payload.project_id,
                payload.user_id,
                "ERROR",
                "outbox",
                `Outbox delivery failed after ${MAX_RETRIES} attempts: ${redisErr.message}. Marked as DEAD_LETTER.`
              ).catch(() => {});
            }
          } else {
            // Increment retry count with exponential backoff (2s, 4s, 8s, up to 60s)
            const backoffSeconds = Math.min(Math.pow(2, nextRetry), 60);
            await client.query(
              `UPDATE outbox_events
               SET retry_count = $1,
                   error_message = $2,
                   next_retry_at = NOW() + ($3 || ' seconds')::interval
               WHERE id = $4`,
              [nextRetry, redisErr.message, backoffSeconds, event.id]
            );
          }
        }
      }

      await client.query("COMMIT");
      return processedCount;
    } catch (error) {
      await client.query("ROLLBACK");
      console.error("[OutboxRelay] Error draining outbox:", error.message);
      return 0;
    } finally {
      client.release();
    }
  })().finally(() => {
    activeRelayPromise = null;
  });

  return activeRelayPromise;
}

/**
 * Immediate post-commit trigger for sub-millisecond dispatch
 */
function triggerOutboxRelay() {
  setImmediate(() => {
    relayPendingEvents().catch((err) => {
      console.warn("[OutboxRelay] Immediate trigger warning:", err.message);
    });
  });
}

/**
 * Reap deployments stuck in INITIATED or QUEUED for > thresholdMinutes with no active PENDING outbox events.
 * @param {number} thresholdMinutes
 * @returns {Promise<Array>}
 */
async function reapStuckDeployments(thresholdMinutes = REAPER_STUCK_MINUTES) {
  try {
    const res = await pool.query(
      `SELECT d.id, d.project_id, d.status
       FROM deployments d
       WHERE d.status IN ('INITIATED', 'QUEUED')
         AND d.created_at < NOW() - ($1 || ' minutes')::interval
         AND NOT EXISTS (
           SELECT 1 FROM outbox_events o
           WHERE o.aggregate_type = 'DEPLOYMENT'
             AND o.aggregate_id = d.id
             AND o.status = 'PENDING'
         )`,
      [thresholdMinutes]
    );

    for (const dep of res.rows) {
      const errorMsg = `Deployment timed out: stuck in ${dep.status} status with no active outbox task`;
      await pool.query(
        `UPDATE deployments
         SET status = 'FAILED', error_message = $1, updated_at = NOW()
         WHERE id = $2 AND status IN ('INITIATED', 'QUEUED')`,
        [errorMsg, dep.id]
      );

      if (dep.project_id) {
        await pool.query(
          `UPDATE projects
           SET status = 'Failed', updated_at = NOW()
           WHERE id = $1 AND status IN ('INITIATED', 'QUEUED')`,
          [dep.project_id]
        );
      }
      console.warn(`[OutboxReaper] Reaped stuck deployment ${dep.id} (was ${dep.status})`);
    }

    return res.rows;
  } catch (err) {
    console.error("[OutboxReaper] Error reaping stuck deployments:", err.message);
    return [];
  }
}

/**
 * Start the periodic background reliability sweep
 */
function startOutboxRelayLoop(intervalMs = SWEEP_INTERVAL_MS) {
  if (sweepTimer) return;

  // Initial sweep immediately on boot
  relayPendingEvents().catch(() => {});
  reapStuckDeployments().catch(() => {});

  sweepTimer = setInterval(() => {
    relayPendingEvents().catch((err) => {
      console.warn("[OutboxRelay] Periodic sweep warning:", err.message);
    });
  }, intervalMs);

  // Periodic reaper check every 60s
  reaperTimer = setInterval(() => {
    reapStuckDeployments().catch((err) => {
      console.warn("[OutboxReaper] Periodic check warning:", err.message);
    });
  }, 60000);

  console.log(`[OutboxRelay] Background sweep started (interval: ${intervalMs}ms)`);
}

/**
 * Stop the periodic sweep
 */
function stopOutboxRelayLoop() {
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
    console.log("[OutboxRelay] Background sweep stopped.");
  }
  if (reaperTimer) {
    clearInterval(reaperTimer);
    reaperTimer = null;
  }
}

module.exports = {
  relayPendingEvents,
  triggerOutboxRelay,
  startOutboxRelayLoop,
  stopOutboxRelayLoop,
  reapStuckDeployments,
  SWEEP_INTERVAL_MS,
  MAX_RETRIES,
  REAPER_STUCK_MINUTES,
};
