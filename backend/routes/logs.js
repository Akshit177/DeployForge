const express = require("express");
const pool = require("../config/db.js");
const redis = require("../config/redis.js");
const { authenticateToken, authenticateTokenOrQuery, assertOwnsDeployment, assertOwnsProject } = require("../middleware/auth.js");
const { parsePagination } = require("../middleware/pagination.js");
const {
  emitDeploymentLog,
  subscribeToDeploymentLogs,
  subscribeToProjectLogs,
} = require("../services/logEmitter.js");

const router = express.Router();

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ALLOWED_LEVELS = ["INFO", "WARN", "ERROR", "SYSTEM", "STEP", "DEBUG"];

function formatLogTime(dateVal) {
  const d = dateVal ? new Date(dateVal) : new Date();
  const hrs = String(d.getHours()).padStart(2, "0");
  const mins = String(d.getMinutes()).padStart(2, "0");
  const secs = String(d.getSeconds()).padStart(2, "0");
  const ms = String(d.getMilliseconds()).padStart(3, "0");
  return `${hrs}:${mins}:${secs}.${ms}`;
}

function formatLogEntry(l) {
  const level = (l.level || "INFO").toUpperCase();
  const dateObj = l.created_at ? new Date(l.created_at) : new Date();
  const isoStr = dateObj.toISOString();
  return {
    id: l.id,
    deployment_id: l.deployment_id,
    project_id: l.project_id,
    user_id: l.user_id,
    level: level,
    source: l.source || "build",
    text: l.message || "",
    message: l.message || "",
    time: formatLogTime(l.created_at),
    created_at: isoStr,
    timestamp: isoStr,
  };
}

// Shared authenticator: cookie, Bearer header or ?token= (EventSource cannot set headers).
// Unlike the previous hand-rolled version it enforces Redis session revocation (logout) too.
const authenticateSseOrCookie = authenticateTokenOrQuery;

// GET /api/logs - Historical logs
router.get("/", authenticateSseOrCookie, parsePagination, async (req, res) => {
  const { deployment_id, project_id, level } = req.query;
  const { limit, offset, since, until } = req.pagination;

  try {
    const params = [req.user.id];
    let whereClause = `l.user_id = $1`;

    if (deployment_id) {
      if (!UUID_REGEX.test(deployment_id)) {
        return res.status(400).json({ message: "Invalid deployment_id format." });
      }
      params.push(deployment_id);
      whereClause += ` AND l.deployment_id = $${params.length}`;
    }

    if (project_id) {
      if (!UUID_REGEX.test(project_id)) {
        return res.status(400).json({ message: "Invalid project_id format." });
      }
      params.push(project_id);
      whereClause += ` AND l.project_id = $${params.length}`;
    }

    if (level && level !== "All") {
      params.push(String(level).toUpperCase());
      whereClause += ` AND UPPER(l.level) = $${params.length}`;
    }

    let query;
    if (since) {
      params.push(since);
      whereClause += ` AND l.created_at > $${params.length}`;
      if (until) {
        params.push(until);
        whereClause += ` AND l.created_at <= $${params.length}`;
      }
      params.push(limit);
      params.push(offset);
      query = `
        SELECT l.*
        FROM logs l
        WHERE ${whereClause}
        ORDER BY l.created_at ASC
        LIMIT $${params.length - 1} OFFSET $${params.length}
      `;
    } else {
      if (until) {
        params.push(until);
        whereClause += ` AND l.created_at <= $${params.length}`;
      }
      params.push(limit);
      params.push(offset);
      query = `
        SELECT *
        FROM (
          SELECT l.*
          FROM logs l
          WHERE ${whereClause}
          ORDER BY l.created_at DESC
          LIMIT $${params.length - 1} OFFSET $${params.length}
        ) sub
        ORDER BY sub.created_at ASC
      `;
    }

    const result = await pool.query(query, params);
    const logs = result.rows.map(formatLogEntry);

    return res.status(200).json({
      logs,
      count: logs.length,
    });
  } catch (error) {
    console.error("Failed to query logs:", error);
    return res.status(500).json({ message: "Unable to retrieve logs right now." });
  }
});

// GET /api/logs/stream - Server-Sent Events (SSE) live streaming
router.get("/stream", authenticateSseOrCookie, async (req, res) => {
  const { deployment_id, project_id } = req.query;

  if (deployment_id && !UUID_REGEX.test(deployment_id)) {
    return res.status(400).json({ message: "Invalid deployment_id format." });
  }
  if (project_id && !UUID_REGEX.test(project_id)) {
    return res.status(400).json({ message: "Invalid project_id format." });
  }

  if (!deployment_id && !project_id) {
    return res.status(400).json({ message: "Either deployment_id or project_id query parameter is required." });
  }

  // Verify ownership before opening SSE stream
  if (deployment_id) {
    const dep = await assertOwnsDeployment(req.user.id, deployment_id);
    if (!dep) {
      return res.status(404).json({ message: "Deployment not found." });
    }
  }

  if (project_id) {
    const proj = await assertOwnsProject(req.user.id, project_id);
    if (!proj) {
      return res.status(404).json({ message: "Project not found." });
    }
  }

  // Set SSE Headers
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders?.();

  let closed = false;
  let pingInterval = null;
  let unsubscribeEmitter = null;
  let subClient = null;

  const cleanup = () => {
    if (closed) return;
    closed = true;
    if (pingInterval) clearInterval(pingInterval);
    if (unsubscribeEmitter) {
      try { unsubscribeEmitter(); } catch (_) {}
    }
    if (subClient) {
      try { subClient.disconnect(); } catch (_) {}
    }
    try { res.end(); } catch (_) {}
  };

  req.on("close", cleanup);
  res.on("close", cleanup);

  if (req.destroyed || req.closed) {
    cleanup();
    return;
  }

  // Send initial connection event
  res.write(`event: connected\ndata: ${JSON.stringify({ message: "Connected to live log stream" })}\n\n`);

  // Fetch recent historical logs to prime the client console
  try {
    const params = [req.user.id];
    let query = `SELECT * FROM logs WHERE user_id = $1`;
    if (deployment_id) {
      params.push(deployment_id);
      query += ` AND deployment_id = $${params.length}`;
    }
    if (project_id) {
      params.push(project_id);
      query += ` AND project_id = $${params.length}`;
    }
    query += ` ORDER BY created_at DESC LIMIT 60`;
    const historical = await pool.query(query, params);
    if (!closed) {
      const initialLogs = historical.rows.reverse().map(formatLogEntry);
      res.write(`event: init\ndata: ${JSON.stringify(initialLogs)}\n\n`);
    }
  } catch (initErr) {
    console.warn("Could not fetch initial stream logs:", initErr.message);
  }

  if (closed) {
    cleanup();
    return;
  }

  // Deduplicate entries arriving from both Redis pub/sub and in-process emitter
  const seenLogIds = new Set();
  const logListener = (logEntry) => {
    if (closed) return;
    if (logEntry.user_id && logEntry.user_id !== req.user.id) {
      return;
    }
    if (logEntry.id) {
      if (seenLogIds.has(logEntry.id)) return;
      seenLogIds.add(logEntry.id);
      if (seenLogIds.size > 2000) {
        const first = seenLogIds.values().next().value;
        seenLogIds.delete(first);
      }
    }
    try {
      res.write(`event: log\ndata: ${JSON.stringify(logEntry)}\n\n`);
    } catch (_) {
      cleanup();
    }
  };

  // 1. In-process emitter subscription as fallback / local
  if (deployment_id) {
    unsubscribeEmitter = subscribeToDeploymentLogs(deployment_id, logListener);
  } else if (project_id) {
    unsubscribeEmitter = subscribeToProjectLogs(project_id, logListener);
  }

  // 2. Redis Pub/Sub subscription using duplicate client
  try {
    subClient = redis.duplicate();
    if (subClient.status !== "ready" && subClient.status !== "connecting") {
      await subClient.connect().catch(() => {});
    }

    if (closed) {
      cleanup();
      return;
    }

    const channelsToSub = [];
    if (deployment_id) {
      channelsToSub.push(`logs:${deployment_id}`);
    }
    if (project_id) {
      channelsToSub.push(`project:${project_id}`);
    }

    if (channelsToSub.length > 0) {
      await subClient.subscribe(...channelsToSub).catch(() => {});
      subClient.on("message", (channel, rawMessage) => {
        if (closed) return;
        try {
          const entry = typeof rawMessage === "string" ? JSON.parse(rawMessage) : rawMessage;
          const formatted = formatLogEntry(entry);
          logListener(formatted);
        } catch (e) {
          // ignore parsing error
        }
      });
    }
  } catch (redisSubErr) {
    console.warn("Redis pub/sub subscription notice:", redisSubErr.message);
  }

  if (closed) {
    cleanup();
    return;
  }

  // Send heartbeat ping every 15 seconds to prevent idle socket closing
  pingInterval = setInterval(() => {
    try {
      res.write(": heartbeat\n\n");
    } catch (_) {
      cleanup();
    }
  }, 15000);
  if (pingInterval.unref) pingInterval.unref();
});

// POST /api/logs - Ingest logs (used by workers, containers, or test harnesses)
router.post("/", authenticateSseOrCookie, async (req, res) => {
  const payload = req.body;
  const entries = Array.isArray(payload) ? payload : [payload];

  if (entries.length === 0) {
    return res.status(400).json({ message: "No log entries provided." });
  }

  try {
    const insertedLogs = [];

    for (const entry of entries) {
      const {
        deployment_id,
        level = "INFO",
        source = "build",
        message,
        text,
      } = entry;

      const logText = message || text;
      if (!logText || typeof logText !== "string") {
        continue;
      }

      if (!deployment_id || !UUID_REGEX.test(deployment_id)) {
        continue;
      }

      // Verify caller owns the deployment
      const dep = await assertOwnsDeployment(req.user.id, deployment_id);
      if (!dep) {
        continue;
      }

      const pId = dep.project_id;
      const normalizedLevel = ALLOWED_LEVELS.includes(String(level).toUpperCase())
        ? String(level).toUpperCase()
        : "INFO";

      const insertRes = await pool.query(
        `INSERT INTO logs (
          deployment_id, project_id, user_id, level, source, message
        ) VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING *`,
        [deployment_id, pId, req.user.id, normalizedLevel, String(source || "build").slice(0, 50), logText]
      );

      const formatted = formatLogEntry(insertRes.rows[0]);
      insertedLogs.push(formatted);

      // Emit live event to subscribers
      emitDeploymentLog(deployment_id, formatted);
    }

    if (insertedLogs.length === 0) {
      return res.status(404).json({ message: "Deployment not found or unauthorized." });
    }

    return res.status(201).json({
      message: `Ingested ${insertedLogs.length} log line(s).`,
      count: insertedLogs.length,
      logs: insertedLogs,
    });
  } catch (error) {
    console.error("Failed to ingest logs:", error);
    return res.status(500).json({ message: "Unable to ingest logs right now." });
  }
});

module.exports = router;
