const pool = require("../config/db.js");
const queue = require("./queue.js");
const { recordWorkerLog } = require("./logEmitter.js");

const SWEEP_INTERVAL_MS = Number(process.env.OUTBOX_SWEEP_INTERVAL_MS || 3000);
const MAX_RETRIES = Number(process.env.OUTBOX_MAX_RETRIES || 5);

let sweepTimer = null;
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
         WHERE status = 'PENDING' AND retry_count < $1
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
            // Increment retry count and preserve PENDING status for next sweep cycle
            await client.query(
              `UPDATE outbox_events
               SET retry_count = $1,
                   error_message = $2
               WHERE id = $3`,
              [nextRetry, redisErr.message, event.id]
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
 * Start the periodic background reliability sweep
 */
function startOutboxRelayLoop(intervalMs = SWEEP_INTERVAL_MS) {
  if (sweepTimer) return;

  // Initial sweep immediately on boot
  relayPendingEvents().catch(() => {});

  sweepTimer = setInterval(() => {
    relayPendingEvents().catch((err) => {
      console.warn("[OutboxRelay] Periodic sweep warning:", err.message);
    });
  }, intervalMs);

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
}

module.exports = {
  relayPendingEvents,
  triggerOutboxRelay,
  startOutboxRelayLoop,
  stopOutboxRelayLoop,
  SWEEP_INTERVAL_MS,
  MAX_RETRIES,
};
