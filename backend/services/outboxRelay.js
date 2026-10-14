const pool = require("../config/db.js");
const { publishDeploymentJob } = require("./queue.js");
const { recordWorkerLog } = require("./logEmitter.js");

const SWEEP_INTERVAL_MS = Number(process.env.OUTBOX_SWEEP_INTERVAL_MS || 3000);

let sweepTimer = null;
let activeRelayPromise = null;

/**
 * Drain pending outbox events and publish them to Redis Streams.
 * Uses SELECT ... FOR UPDATE SKIP LOCKED to ensure concurrency safety across multiple workers/nodes.
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
         ORDER BY created_at ASC
         LIMIT 50
         FOR UPDATE SKIP LOCKED`
      );

      const events = selectRes.rows;

      for (const event of events) {
        const payload = typeof event.payload === "string" ? JSON.parse(event.payload) : event.payload;

        try {
          // Publish deployment job to Redis Stream
          await publishDeploymentJob(payload);

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

          // Increment retry count and preserve PENDING status for next sweep cycle
          await client.query(
            `UPDATE outbox_events
             SET retry_count = retry_count + 1,
                 error_message = $1
             WHERE id = $2`,
            [redisErr.message, event.id]
          );
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
};
