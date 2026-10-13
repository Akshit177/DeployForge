const express = require("express");
const pool = require("../config/db.js");
const { authenticateToken } = require("../middleware/auth.js");
const { publishDeploymentJob } = require("../services/queue.js");

const router = express.Router();

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ALLOWED_RUNTIMES = ["node", "python", "go", "docker", "static"];

function sanitizeProjectName(rawName) {
  if (typeof rawName !== "string") return "";
  return rawName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-_]/g, "-")
    .replace(/^-+|-+$/g, "");
}

function normalizeRepoUrl(rawUrl) {
  if (typeof rawUrl !== "string") return "";
  let url = rawUrl.trim();
  if (url.startsWith("git@github.com:")) {
    url = url.replace("git@github.com:", "https://github.com/");
  } else if (!/^https?:\/\//i.test(url) && (url.startsWith("github.com") || url.startsWith("gitlab.com"))) {
    url = `https://${url}`;
  }
  return url;
}

function formatProject(p) {
  const runtimeType = p.runtime || "node";
  const port = p.port || 3000;
  const runtimeDisplay =
    runtimeType === "node"
      ? `Node 20 · :${port}`
      : runtimeType === "python"
      ? `Python 3.12 · :${port}`
      : runtimeType === "go"
      ? `Go 1.22 · :${port}`
      : runtimeType === "static"
      ? `Static · :${port}`
      : `Docker · :${port}`;

  return {
    id: p.id,
    name: p.name,
    repo: p.repository_url,
    repository_url: p.repository_url,
    branch: p.branch || "main",
    runtime: runtimeDisplay,
    runtimeType: runtimeType,
    port: port,
    auto_deploy: Boolean(p.auto_deploy),
    env_vars: Array.isArray(p.env_vars) ? p.env_vars : [],
    state: p.status || "Queued",
    status: p.status || "Queued",
    url: p.domain || `${p.name}.deployforge.app`,
    domain: p.domain || `${p.name}.deployforge.app`,
    commit: p.latest_commit || "HEAD",
    latest_commit: p.latest_commit || "HEAD",
    created_at: p.created_at,
    updated_at: p.updated_at,
  };
}

// All project routes require valid authentication
router.use(authenticateToken);

// GET /api/projects - List all projects for authenticated user
router.get("/", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM projects WHERE user_id = $1 ORDER BY created_at DESC`,
      [req.user.id]
    );

    const projects = result.rows.map(formatProject);
    return res.status(200).json({
      projects,
      count: projects.length,
    });
  } catch (error) {
    console.error("Failed to fetch projects:", error);
    return res.status(500).json({ message: "Unable to retrieve projects right now." });
  }
});

// POST /api/projects - Create a new project
router.post("/", async (req, res) => {
  const {
    name,
    repository_url,
    repoUrl,
    branch = "main",
    runtime = "node",
    port = 3000,
    auto_deploy = true,
    autoDeploy,
    env_vars = [],
    envVars,
  } = req.body;

  const rawName = name;
  const rawRepo = repository_url || repoUrl;
  const projectSlug = sanitizeProjectName(rawName);
  const normalizedRepo = normalizeRepoUrl(rawRepo);

  if (!projectSlug || projectSlug.length < 2 || projectSlug.length > 64) {
    return res.status(400).json({
      message: "Project name must be 2-64 characters long and contain only letters, numbers, hyphens, and underscores.",
    });
  }

  if (!normalizedRepo || !/^https?:\/\/.+/i.test(normalizedRepo)) {
    return res.status(400).json({
      message: "Please provide a valid repository URL (e.g., https://github.com/organization/repository).",
    });
  }

  const selectedRuntime = ALLOWED_RUNTIMES.includes(runtime) ? runtime : "node";
  const parsedPort = Number.parseInt(port, 10);
  const internalPort = Number.isInteger(parsedPort) && parsedPort >= 1 && parsedPort <= 65535 ? parsedPort : 3000;
  const isAutoDeploy = autoDeploy !== undefined ? Boolean(autoDeploy) : Boolean(auto_deploy);
  const varsToSave = Array.isArray(envVars) ? envVars : Array.isArray(env_vars) ? env_vars : [];
  const domain = `${projectSlug}.deployforge.app`;

  try {
    // Check if user already has a project with this name
    const existing = await pool.query(
      `SELECT id FROM projects WHERE user_id = $1 AND name = $2`,
      [req.user.id, projectSlug]
    );

    if (existing.rows.length > 0) {
      return res.status(409).json({
        message: `You already have a project named "${projectSlug}". Please choose a different name.`,
      });
    }

    const insertResult = await pool.query(
      `INSERT INTO projects (
        user_id, name, repository_url, branch, runtime, port, auto_deploy, env_vars, status, domain, latest_commit
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11)
      RETURNING *`,
      [
        req.user.id,
        projectSlug,
        normalizedRepo,
        String(branch).trim() || "main",
        selectedRuntime,
        internalPort,
        isAutoDeploy,
        JSON.stringify(varsToSave),
        "Queued",
        domain,
        "main",
      ]
    );

    const newProject = insertResult.rows[0];

    // Automatically queue initial deployment for the newly created project
    try {
      const initialDepRes = await pool.query(
        `INSERT INTO deployments (
          project_id, user_id, commit_hash, commit_message, branch, status, trigger, environment, url
        ) VALUES ($1, $2, $3, $4, $5, 'Queued', 'initial', 'production', $6)
        RETURNING *`,
        [
          newProject.id,
          req.user.id,
          newProject.latest_commit || "HEAD",
          "Initial project import",
          newProject.branch,
          domain,
        ]
      );
      if (initialDepRes.rows.length > 0) {
        const initDep = initialDepRes.rows[0];
        await publishDeploymentJob({
          deployment_id: initDep.id,
          project_id: newProject.id,
          user_id: req.user.id,
          repo_url: newProject.repository_url,
          branch: newProject.branch,
          commit_hash: newProject.latest_commit,
          runtime: newProject.runtime,
          port: newProject.port,
          trigger: "initial",
        });
      }
    } catch (deployErr) {
      console.warn("Could not insert/dispatch initial deployment:", deployErr.message);
    }

    return res.status(201).json({
      message: `Project ${projectSlug} created successfully.`,
      project: formatProject(newProject),
    });
  } catch (error) {
    if (error.code === "23505") {
      return res.status(409).json({
        message: `You already have a project named "${projectSlug}". Please choose a different name.`,
      });
    }
    console.error("Failed to create project:", error);
    return res.status(500).json({ message: "Unable to create project right now." });
  }
});

// GET /api/projects/:id - Get project details
router.get("/:id", async (req, res) => {
  const { id } = req.params;

  if (!UUID_REGEX.test(id)) {
    return res.status(400).json({ message: "Invalid project ID format." });
  }

  try {
    const result = await pool.query(
      `SELECT * FROM projects WHERE id = $1 AND user_id = $2`,
      [id, req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: "Project not found." });
    }

    return res.status(200).json({
      project: formatProject(result.rows[0]),
    });
  } catch (error) {
    console.error("Failed to fetch project:", error);
    return res.status(500).json({ message: "Unable to retrieve project." });
  }
});

// PATCH /api/projects/:id - Update project configuration
router.patch("/:id", async (req, res) => {
  const { id } = req.params;

  if (!UUID_REGEX.test(id)) {
    return res.status(400).json({ message: "Invalid project ID format." });
  }

  try {
    const check = await pool.query(
      `SELECT * FROM projects WHERE id = $1 AND user_id = $2`,
      [id, req.user.id]
    );

    if (check.rows.length === 0) {
      return res.status(404).json({ message: "Project not found." });
    }

    const current = check.rows[0];
    const {
      name,
      branch,
      runtime,
      port,
      auto_deploy,
      autoDeploy,
      env_vars,
      envVars,
      status,
    } = req.body;

    let newName = current.name;
    let newDomain = current.domain;
    if (name !== undefined) {
      const sanitized = sanitizeProjectName(name);
      if (!sanitized || sanitized.length < 2) {
        return res.status(400).json({ message: "Invalid project name." });
      }
      if (sanitized !== current.name) {
        const dup = await pool.query(
          `SELECT id FROM projects WHERE user_id = $1 AND name = $2 AND id != $3`,
          [req.user.id, sanitized, id]
        );
        if (dup.rows.length > 0) {
          return res.status(409).json({ message: `Project named "${sanitized}" already exists.` });
        }
        newName = sanitized;
        newDomain = `${sanitized}.deployforge.app`;
      }
    }

    const newBranch = branch !== undefined ? String(branch).trim() || current.branch : current.branch;
    const newRuntime = runtime !== undefined && ALLOWED_RUNTIMES.includes(runtime) ? runtime : current.runtime;
    const newPort = port !== undefined && Number.isInteger(Number(port)) ? Number(port) : current.port;
    const newAutoDeploy =
      autoDeploy !== undefined
        ? Boolean(autoDeploy)
        : auto_deploy !== undefined
        ? Boolean(auto_deploy)
        : current.auto_deploy;

    const varsSource =
      envVars !== undefined
        ? envVars
        : env_vars !== undefined
        ? env_vars
        : current.env_vars;
    const envVarsJson = typeof varsSource === "string" ? varsSource : JSON.stringify(varsSource || []);
    const newStatus = status !== undefined ? String(status).trim() : current.status;

    const updateResult = await pool.query(
      `UPDATE projects
       SET name = $1,
           domain = $2,
           branch = $3,
           runtime = $4,
           port = $5,
           auto_deploy = $6,
           env_vars = $7::jsonb,
           status = $8,
           updated_at = NOW()
       WHERE id = $9 AND user_id = $10
       RETURNING *`,
      [newName, newDomain, newBranch, newRuntime, newPort, newAutoDeploy, envVarsJson, newStatus, id, req.user.id]
    );

    return res.status(200).json({
      message: "Project updated successfully.",
      project: formatProject(updateResult.rows[0]),
    });
  } catch (error) {
    console.error("Failed to update project:", error);
    return res.status(500).json({ message: "Unable to update project." });
  }
});

// DELETE /api/projects/:id - Delete a project
router.delete("/:id", async (req, res) => {
  const { id } = req.params;

  if (!UUID_REGEX.test(id)) {
    return res.status(400).json({ message: "Invalid project ID format." });
  }

  try {
    const result = await pool.query(
      `DELETE FROM projects WHERE id = $1 AND user_id = $2 RETURNING id, name`,
      [id, req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: "Project not found or already deleted." });
    }

    return res.status(200).json({
      message: `Project ${result.rows[0].name} deleted successfully.`,
      id: result.rows[0].id,
    });
  } catch (error) {
    console.error("Failed to delete project:", error);
    return res.status(500).json({ message: "Unable to delete project." });
  }
});

// Nested sub-routes for Environment Variables & Encrypted Secrets Vault
const envRoutes = require("./envVars.js");
router.use("/:projectId/env", envRoutes);
router.use("/:id/env", envRoutes);

module.exports = router;
