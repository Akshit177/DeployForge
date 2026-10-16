const express = require("express");
const pool = require("../config/db.js");
const { decrypt } = require("../services/crypto.js");

const router = express.Router();

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BLOCKED_KEYS = new Set(["LD_PRELOAD", "LD_LIBRARY_PATH"]);

/**
 * Authentication middleware for internal control-plane requests.
 * Uses shared secret token in X-Internal-Token header.
 */
function authenticateInternalToken(req, res, next) {
  const expectedToken = process.env.INTERNAL_TOKEN || "deployforge-internal-dev-token";
  const providedToken = req.headers["x-internal-token"];

  if (!providedToken || providedToken !== expectedToken) {
    return res.status(401).json({ error: "Invalid or missing internal token" });
  }

  return next();
}

router.use(authenticateInternalToken);

// GET /internal/deployments/:id/env - Fetch decrypted environment variables for a deployment
router.get("/deployments/:id/env", async (req, res) => {
  const { id } = req.params;

  if (!UUID_REGEX.test(id)) {
    return res.status(400).json({ error: "Invalid deployment ID format" });
  }

  try {
    const depRes = await pool.query(
      `SELECT d.id AS deployment_id, d.project_id,
              p.id AS project_id, p.port AS project_port
       FROM deployments d
       JOIN projects p ON d.project_id = p.id
       WHERE d.id = $1`,
      [id]
    );

    if (depRes.rows.length === 0) {
      return res.status(404).json({ error: "Deployment not found" });
    }

    const dep = depRes.rows[0];
    const internalPort = dep.project_port || 3000;

    const envRes = await pool.query(
      `SELECT key, encrypted_value, iv, auth_tag, is_secret
       FROM project_env_vars
       WHERE project_id = $1
       ORDER BY key ASC`,
      [dep.project_id]
    );

    const env = {
      PORT: String(internalPort),
      NODE_ENV: "production",
    };

    for (const row of envRes.rows) {
      const upperKey = String(row.key).toUpperCase().trim();
      if (BLOCKED_KEYS.has(upperKey)) {
        continue;
      }

      try {
        const decryptedVal = decrypt(row.encrypted_value, row.iv, row.auth_tag);
        env[upperKey] = decryptedVal;
      } catch (err) {
        console.warn(`[Internal] Failed to decrypt env var ${upperKey} for project ${dep.project_id}:`, err.message);
      }
    }

    return res.status(200).json({ env });
  } catch (error) {
    console.error("[Internal] Failed to fetch deployment env:", error);
    return res.status(500).json({ error: "Unable to retrieve environment variables" });
  }
});

module.exports = router;
