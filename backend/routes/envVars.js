const express = require("express");
const pool = require("../config/db.js");
const { authenticateToken } = require("../middleware/auth.js");
const { encrypt, decrypt } = require("../services/crypto.js");

const router = express.Router({ mergeParams: true });

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY_REGEX = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const BLOCKED_KEYS = new Set(["LD_PRELOAD", "LD_LIBRARY_PATH"]);
const MAX_ENV_VARS_PER_PROJECT = 100;
const MAX_VALUE_BYTES = 8192; // 8 KB

function sanitizeKey(rawKey) {
  if (typeof rawKey !== "string") return "";
  return rawKey.trim().toUpperCase();
}

function isLikelySecret(key, isSecretParam) {
  if (isSecretParam !== undefined) return Boolean(isSecretParam);
  const secretKeywords = ["SECRET", "PASSWORD", "KEY", "TOKEN", "AUTH", "CREDENTIAL", "PRIVATE"];
  return secretKeywords.some((kw) => key.includes(kw));
}

// All env routes require authenticated user
router.use(authenticateToken);

// Middleware to verify project ownership
async function verifyProjectOwnership(req, res, next) {
  const projectId = req.params.projectId || req.params.id;

  if (!projectId || !UUID_REGEX.test(projectId)) {
    return res.status(400).json({ message: "Invalid project ID format." });
  }

  try {
    const result = await pool.query(
      `SELECT * FROM projects WHERE id = $1 AND user_id = $2`,
      [projectId, req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: "Project not found or unauthorized." });
    }

    req.project = result.rows[0];
    return next();
  } catch (error) {
    console.error("Project authorization failed:", error);
    return res.status(500).json({ message: "Unable to verify project access." });
  }
}

// GET /api/projects/:id/env - Retrieve project environment variables
router.get("/", verifyProjectOwnership, async (req, res) => {
  const reveal = req.query.reveal === "true";

  try {
    const result = await pool.query(
      `SELECT id, key, encrypted_value, iv, auth_tag, is_secret, created_at, updated_at
       FROM project_env_vars
       WHERE project_id = $1
       ORDER BY key ASC`,
      [req.project.id]
    );

    const envVars = result.rows.map((row) => {
      let plainValue = "";
      try {
        plainValue = decrypt(row.encrypted_value, row.iv, row.auth_tag);
      } catch (decErr) {
        console.warn(`Decryption error for ${row.key}:`, decErr.message);
        plainValue = "[Decryption Error]";
      }

      const displayValue = row.is_secret && !reveal ? "••••••••••••••••" : plainValue;

      return {
        id: row.id,
        key: row.key,
        value: displayValue,
        isSecret: row.is_secret,
        is_secret: row.is_secret,
        created_at: row.created_at,
        updated_at: row.updated_at,
      };
    });

    return res.status(200).json({
      project_id: req.project.id,
      env_vars: envVars,
      count: envVars.length,
    });
  } catch (error) {
    console.error("Failed to retrieve environment variables:", error);
    return res.status(500).json({ message: "Unable to retrieve environment variables." });
  }
});

// POST /api/projects/:id/env - Atomically upsert one or more environment variables in a single transaction
router.post("/", verifyProjectOwnership, async (req, res) => {
  const payload = req.body;
  const items = Array.isArray(payload)
    ? payload
    : Array.isArray(payload.variables)
    ? payload.variables
    : [payload];

  if (items.length === 0) {
    return res.status(400).json({ message: "No environment variables provided." });
  }

  // Pre-validate all items before beginning database work
  const validatedItems = [];
  for (const item of items) {
    const rawKey = item.key;
    const rawVal = item.value ?? "";
    const key = sanitizeKey(rawKey);

    if (!key || !KEY_REGEX.test(key)) {
      return res.status(400).json({
        message: `Invalid variable key "${rawKey}". Must start with a letter/underscore and contain only letters, numbers, or underscores.`,
      });
    }

    if (BLOCKED_KEYS.has(key)) {
      return res.status(400).json({
        message: `Environment variable key "${key}" is reserved and not allowed.`,
      });
    }

    const valStr = String(rawVal);
    if (Buffer.byteLength(valStr, "utf8") > MAX_VALUE_BYTES) {
      return res.status(400).json({
        message: `Variable value for "${key}" exceeds maximum allowed size of 8 KB.`,
      });
    }

    const isSecret = isLikelySecret(key, item.isSecret !== undefined ? item.isSecret : item.is_secret);
    validatedItems.push({ key, valStr, isSecret });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Check project total variable limit
    const existingRes = await client.query(
      `SELECT key FROM project_env_vars WHERE project_id = $1`,
      [req.project.id]
    );
    const existingKeys = new Set(existingRes.rows.map((r) => r.key));

    for (const v of validatedItems) {
      existingKeys.add(v.key);
    }

    if (existingKeys.size > MAX_ENV_VARS_PER_PROJECT) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        message: `Maximum limit of ${MAX_ENV_VARS_PER_PROJECT} environment variables per project exceeded.`,
      });
    }

    const upsertedVars = [];
    const query = `
      INSERT INTO project_env_vars (
        project_id, user_id, key, encrypted_value, iv, auth_tag, is_secret
      ) VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (project_id, key) DO UPDATE SET
        encrypted_value = EXCLUDED.encrypted_value,
        iv = EXCLUDED.iv,
        auth_tag = EXCLUDED.auth_tag,
        is_secret = EXCLUDED.is_secret,
        updated_at = NOW()
      RETURNING id, key, is_secret, created_at, updated_at
    `;

    for (const item of validatedItems) {
      const enc = encrypt(item.valStr);
      const insertRes = await client.query(query, [
        req.project.id,
        req.user.id,
        item.key,
        enc.ciphertext,
        enc.iv,
        enc.authTag,
        item.isSecret,
      ]);

      const row = insertRes.rows[0];
      upsertedVars.push({
        id: row.id,
        key: row.key,
        value: item.isSecret ? "••••••••••••••••" : item.valStr,
        isSecret: row.is_secret,
        is_secret: row.is_secret,
        updated_at: row.updated_at,
      });
    }

    await client.query("COMMIT");

    return res.status(201).json({
      message: `Saved ${upsertedVars.length} environment variable(s) successfully.`,
      env_vars: upsertedVars,
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Failed to save environment variables:", error);
    return res.status(500).json({ message: "Unable to store environment variables." });
  } finally {
    client.release();
  }
});

// DELETE /api/projects/:id/env/:keyOrId - Remove an environment variable
router.delete("/:keyOrId", verifyProjectOwnership, async (req, res) => {
  const { keyOrId } = req.params;

  if (!keyOrId) {
    return res.status(400).json({ message: "Variable key or ID is required." });
  }

  const isUuid = UUID_REGEX.test(keyOrId);
  const targetKey = isUuid ? "" : sanitizeKey(keyOrId);

  try {
    const query = isUuid
      ? `DELETE FROM project_env_vars WHERE id = $1 AND project_id = $2 RETURNING id, key`
      : `DELETE FROM project_env_vars WHERE key = $1 AND project_id = $2 RETURNING id, key`;

    const param = isUuid ? keyOrId : targetKey;
    const result = await pool.query(query, [param, req.project.id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ message: "Environment variable not found." });
    }

    return res.status(200).json({
      message: `Environment variable "${result.rows[0].key}" removed successfully.`,
      key: result.rows[0].key,
      id: result.rows[0].id,
    });
  } catch (error) {
    console.error("Failed to delete environment variable:", error);
    return res.status(500).json({ message: "Unable to delete environment variable." });
  }
});

module.exports = router;
