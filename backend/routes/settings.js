const express = require("express");
const bcrypt = require("bcryptjs");
const pool = require("../config/db.js");
const { authenticateToken } = require("../middleware/auth.js");

const router = express.Router();

// Domain validation regex: standard hostname format with at least one dot
const DOMAIN_REGEX = /^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,63}$/;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function formatProfile(user) {
  return {
    id: user.id,
    user_name: user.name || user.user_name,
    email: user.email,
    github_connected: Boolean(user.github_connected),
    notification_preferences: user.notification_preferences || {
      notify_failures: true,
      notify_weekly: false,
    },
    created_at: user.created_at,
    updated_at: user.updated_at,
  };
}

// All settings routes require authentication
router.use(authenticateToken);

/**
 * GET /api/settings
 * Retrieve user profile, account preferences, and custom domains
 */
router.get("/", async (req, res) => {
  try {
    const userResult = await pool.query(
      `SELECT id, name, email, github_connected, notification_preferences, created_at, updated_at
       FROM users WHERE id = $1`,
      [req.user.id]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({ message: "User not found." });
    }

    const domainsResult = await pool.query(
      `SELECT id, domain, status, is_default, project_id, created_at
       FROM custom_domains
       WHERE user_id = $1
       ORDER BY created_at ASC`,
      [req.user.id]
    );

    return res.status(200).json({
      user: formatProfile(userResult.rows[0]),
      domains: domainsResult.rows,
    });
  } catch (error) {
    console.error("Failed to load settings:", error);
    return res.status(500).json({ message: "Failed to load account settings." });
  }
});

/**
 * PUT /api/settings/profile
 * Update personal profile (name, email, github_connected)
 */
router.put("/profile", async (req, res) => {
  const { name, email, github_connected } = req.body;

  if (name !== undefined && (typeof name !== "string" || name.trim().length < 2)) {
    return res.status(400).json({ message: "Name must be at least 2 characters long." });
  }

  let normalizedEmail = undefined;
  if (email !== undefined) {
    if (typeof email !== "string" || !EMAIL_REGEX.test(email.trim().toLowerCase())) {
      return res.status(400).json({ message: "Please provide a valid email address." });
    }
    normalizedEmail = email.trim().toLowerCase();

    // Check email uniqueness if changing email
    const emailConflict = await pool.query(
      "SELECT id FROM users WHERE email = $1 AND id != $2",
      [normalizedEmail, req.user.id]
    );
    if (emailConflict.rows.length > 0) {
      return res.status(409).json({ message: "An account with this email address already exists." });
    }
  }

  try {
    const result = await pool.query(
      `UPDATE users
       SET name = COALESCE($1, name),
           email = COALESCE($2, email),
           github_connected = COALESCE($3, github_connected),
           updated_at = NOW()
       WHERE id = $4
       RETURNING id, name, email, github_connected, notification_preferences, created_at, updated_at`,
      [
        name ? name.trim() : null,
        normalizedEmail || null,
        github_connected !== undefined ? Boolean(github_connected) : null,
        req.user.id,
      ]
    );

    return res.status(200).json({
      message: "Profile updated successfully.",
      user: formatProfile(result.rows[0]),
    });
  } catch (error) {
    if (error.code === "23505") {
      return res.status(409).json({ message: "An account with this email address already exists." });
    }
    console.error("Failed to update profile:", error);
    return res.status(500).json({ message: "Could not update profile." });
  }
});

/**
 * PUT /api/settings/password
 * Verify current password and securely hash new password with bcrypt
 */
router.put("/password", async (req, res) => {
  const { current_password, new_password } = req.body;

  if (!current_password || typeof current_password !== "string") {
    return res.status(400).json({ message: "Current password is required." });
  }

  if (!new_password || typeof new_password !== "string" || new_password.length < 8) {
    return res.status(400).json({ message: "New password must be at least 8 characters long." });
  }

  try {
    const userQuery = await pool.query(
      "SELECT password_hash FROM users WHERE id = $1",
      [req.user.id]
    );
    if (userQuery.rows.length === 0) {
      return res.status(404).json({ message: "User not found." });
    }

    const isMatch = await bcrypt.compare(current_password, userQuery.rows[0].password_hash);
    if (!isMatch) {
      return res.status(400).json({ message: "Current password is incorrect." });
    }

    const newHashed = await bcrypt.hash(new_password, 10);
    await pool.query(
      "UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2",
      [newHashed, req.user.id]
    );

    return res.status(200).json({ message: "Password updated successfully." });
  } catch (error) {
    console.error("Failed to update password:", error);
    return res.status(500).json({ message: "Could not update password." });
  }
});

/**
 * PUT /api/settings/notifications
 * Update notification and alert preferences
 */
router.put("/notifications", async (req, res) => {
  const { notify_failures, notify_weekly } = req.body;

  const currentPrefs = req.user.notification_preferences || {
    notify_failures: true,
    notify_weekly: false,
  };

  const updatedPrefs = {
    notify_failures: notify_failures !== undefined ? Boolean(notify_failures) : currentPrefs.notify_failures,
    notify_weekly: notify_weekly !== undefined ? Boolean(notify_weekly) : currentPrefs.notify_weekly,
  };

  try {
    const result = await pool.query(
      `UPDATE users
       SET notification_preferences = $1,
           updated_at = NOW()
       WHERE id = $2
       RETURNING notification_preferences`,
      [JSON.stringify(updatedPrefs), req.user.id]
    );

    return res.status(200).json({
      message: "Alert preferences updated.",
      notification_preferences: result.rows[0].notification_preferences,
    });
  } catch (error) {
    console.error("Failed to update notification preferences:", error);
    return res.status(500).json({ message: "Could not update notification preferences." });
  }
});

/**
 * GET /api/settings/domains
 * List all custom domains for the authenticated user
 */
router.get("/domains", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, domain, status, is_default, project_id, created_at
       FROM custom_domains
       WHERE user_id = $1
       ORDER BY created_at ASC`,
      [req.user.id]
    );
    return res.status(200).json({ domains: result.rows });
  } catch (error) {
    console.error("Failed to fetch domains:", error);
    return res.status(500).json({ message: "Could not load custom domains." });
  }
});

/**
 * POST /api/settings/domains
 * Register a new custom domain
 */
router.post("/domains", async (req, res) => {
  const { domain, project_id } = req.body;

  if (!domain || typeof domain !== "string") {
    return res.status(400).json({ message: "Domain name is required." });
  }

  const cleanDomain = domain.trim().toLowerCase();
  if (!DOMAIN_REGEX.test(cleanDomain)) {
    return res.status(400).json({ message: "Please provide a valid fully qualified domain name (e.g., app.yourdomain.com)." });
  }

  try {
    // Check global uniqueness across DeployForge
    const existing = await pool.query("SELECT id FROM custom_domains WHERE domain = $1", [cleanDomain]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ message: "This domain is already registered on DeployForge." });
    }

    // Verify project belongs to user if specified
    let targetProjectId = null;
    if (project_id) {
      const projCheck = await pool.query("SELECT id FROM projects WHERE id = $1 AND user_id = $2", [project_id, req.user.id]);
      if (projCheck.rows.length > 0) {
        targetProjectId = projCheck.rows[0].id;
      }
    }

    const insertResult = await pool.query(
      `INSERT INTO custom_domains (user_id, project_id, domain, status, is_default)
       VALUES ($1, $2, $3, 'Active', false)
       RETURNING id, domain, status, is_default, project_id, created_at`,
      [req.user.id, targetProjectId, cleanDomain]
    );

    return res.status(201).json({
      message: `Domain ${cleanDomain} added successfully.`,
      domain: insertResult.rows[0],
    });
  } catch (error) {
    if (error.code === "23505") {
      return res.status(409).json({ message: "This domain is already registered on DeployForge." });
    }
    console.error("Failed to add domain:", error);
    return res.status(500).json({ message: "Could not register custom domain." });
  }
});

/**
 * DELETE /api/settings/domains/:id
 * Delete a custom domain with strict multi-tenant authorization
 */
router.delete("/domains/:id", async (req, res) => {
  const { id } = req.params;

  try {
    const result = await pool.query(
      "DELETE FROM custom_domains WHERE (id::text = $1 OR domain = $1) AND user_id = $2 RETURNING id, domain",
      [id, req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: "Custom domain not found or unauthorized." });
    }

    return res.status(200).json({
      message: `Domain ${result.rows[0].domain} removed successfully.`,
      deleted_id: result.rows[0].id,
    });
  } catch (error) {
    console.error("Failed to delete domain:", error);
    return res.status(500).json({ message: "Could not delete custom domain." });
  }
});

module.exports = router;
