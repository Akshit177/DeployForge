const express = require("express");
const pool = require("../config/db.js");
const { authenticateToken, assertOwnsDeployment, assertOwnsProject } = require("../middleware/auth.js");
const { parsePagination } = require("../middleware/pagination.js");
const { verifyAccessToken } = require("../services/auth.js");
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
    created_at: l.created_at,
  };
}

// Custom auth helper that checks cookie OR query param token (crucial for SSE EventSource)
async function authenticateSseOrCookie(req, res, next) {
  const token = req.cookies?.token || req.query?.token;

  if (!token) {
    return res.status(401).json({ message: "Access denied. No authentication token provided." });
  }

  let decoded;
  try {
    decoded = verifyAccessToken(token);
  } catch (error) {
    return res.status(401).json({ message: "Invalid authentication token." });
  }

  try {
    const userRes = await pool.query("SELECT * FROM users WHERE id = $1", [decoded.id]);
    if (userRes.rows.length === 0) {
      return res.status(404).json({ message: "User not found." });
    }
    req.user = userRes.rows[0];
    return next();
  } catch (err) {
    return next(err);
  }
}

// GET /api/logs - Historical logs
router.get("/", authenticateSseOrCookie, parsePagination, async (req, res) => {
  const { deployment_id, project_id, level } = req.query;
  const { limit, offset, since, until } = req.pagination;

  try {
    const params = [req.user.id];
    let query = `
      SELECT l.*
      FROM logs l
      WHERE l.user_id = $1
    `;

    if (deployment_id) {
      if (!UUID_REGEX.test(deployment_id)) {
        return res.status(400).json({ message: "Invalid deployment_id format." });
      }
      params.push(deployment_id);
      query += ` AND l.deployment_id = $${params.length}`;
    }

    if (project_id) {
      if (!UUID_REGEX.test(project_id)) {
        return res.status(400).json({ message: "Invalid project_id format." });
      }
      params.push(project_id);
      query += ` AND l.project_id = $${params.length}`;
    }

    if (level && level !== "All") {
      params.push(level.toUpperCase());
      query += ` AND UPPER(l.level) = $${params.length}`;
    }

    if (since) {
      params.push(since);
      query += ` AND l.created_at > $${params.length}`;
    }

    if (until) {
      params.push(until);
      query += ` AND l.created_at <= $${params.length}`;
    }

    params.push(limit);
    params.push(offset);
    query += ` ORDER BY l.created_at ASC LIMIT $${params.length - 1} OFFSET $${params.length}`;

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
    const initialLogs = historical.rows.reverse().map(formatLogEntry);
    res.write(`event: init\ndata: ${JSON.stringify(initialLogs)}\n\n`);
  } catch (initErr) {
    console.warn("Could not fetch initial stream logs:", initErr.message);
  }

  // Listener for live logs with strict tenant isolation
  const logListener = (logEntry) => {
    if (logEntry.user_id && logEntry.user_id !== req.user.id) {
      return;
    }
    res.write(`event: log\ndata: ${JSON.stringify(logEntry)}\n\n`);
  };

  let unsubscribe = null;
  if (deployment_id) {
    unsubscribe = subscribeToDeploymentLogs(deployment_id, logListener);
  } else if (project_id) {
    unsubscribe = subscribeToProjectLogs(project_id, logListener);
  }

  // Send heartbeat ping every 15 seconds to prevent idle socket closing
  const pingInterval = setInterval(() => {
    res.write(": heartbeat\n\n");
  }, 15000);

  // Clean up on disconnect
  req.on("close", () => {
    clearInterval(pingInterval);
    if (unsubscribe) {
      unsubscribe();
    }
    res.end();
  });
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
