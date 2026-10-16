const express = require("express");
const pool = require("../config/db.js");
const { authenticateToken } = require("../middleware/auth.js");
const { parsePagination } = require("../middleware/pagination.js");
const { publishDeploymentJob } = require("../services/queue.js");
const { triggerOutboxRelay } = require("../services/outboxRelay.js");
const { encrypt } = require("../services/crypto.js");
const { isValidRepoUrl, isValidBranch } = require("../utils/validators.js");

const router = express.Router();

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ALLOWED_RUNTIMES = ["node", "python", "go", "docker", "static"];
const GIT_REPO_REGEX = /^https:\/\/(github\.com|gitlab\.com|bitbucket\.org)\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(\.git)?$/i;
const BRANCH_REGEX = /^[A-Za-z0-9._/-]{1,100}$/;
const ENV_KEY_REGEX = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const BLOCKED_ENV_KEYS = new Set(["LD_PRELOAD", "LD_LIBRARY_PATH"]);
const RESERVED_SLUGS = new Set([
  "api",
  "www",
  "admin",
  "app",
  "dashboard",
  "status",
  "health",
  "auth",
  "login",
  "static",
  "deployforge",
]);

async function allocateDomain(client, baseSlug, excludeProjectId = null) {
  const slug = String(baseSlug || "").trim().toLowerCase();
  if (RESERVED_SLUGS.has(slug)) {
    return { error: "Project name / domain prefix is reserved. Please choose another name." };
  }

  const baseDomain = `${slug}.deployforge.app`;
  const checkQuery = `SELECT id FROM projects WHERE domain = $1 ${excludeProjectId ? "AND id != $2" : ""}`;
  const checkParams = excludeProjectId ? [baseDomain, excludeProjectId] : [baseDomain];

  const existing = await client.query(checkQuery, checkParams);
  if (existing.rows.length === 0) {
    return { domain: baseDomain };
  }

  for (let counter = 2; counter <= 1000; counter++) {
    const candidate = `${slug}-${counter}.deployforge.app`;
    const candidateParams = excludeProjectId ? [candidate, excludeProjectId] : [candidate];
    const candidateCheck = await client.query(checkQuery, candidateParams);
    if (candidateCheck.rows.length === 0) {
      return { domain: candidate };
    }
  }

  return { error: "Unable to allocate unique domain after 1000 attempts." };
}

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
  } else if (url.startsWith("git@gitlab.com:")) {
    url = url.replace("git@gitlab.com:", "https://gitlab.com/");
  } else if (url.startsWith("git@bitbucket.org:")) {
    url = url.replace("git@bitbucket.org:", "https://bitbucket.org/");
  } else if (!/^https?:\/\//i.test(url) && (url.startsWith("github.com") || url.startsWith("gitlab.com") || url.startsWith("bitbucket.org"))) {
    url = `https://${url}`;
  }
  return url;
}

function formatProject(p) {
  const runtimeType = p.runtime || "docker";
  const port = p.port || 3000;
  const runtimeDisplay =
    runtimeType === "docker"
      ? `Docker · :${port}`
      : runtimeType === "node"
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
router.get("/", parsePagination, async (req, res) => {
  const { limit, offset, since, until } = req.pagination;

  try {
    const params = [req.user.id];
    let query = `SELECT * FROM projects WHERE user_id = $1`;

    if (since) {
      params.push(since);
      query += ` AND created_at >= $${params.length}`;
    }

    if (until) {
      params.push(until);
      query += ` AND created_at <= $${params.length}`;
    }

    params.push(limit);
    params.push(offset);
    query += ` ORDER BY created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`;

    const result = await pool.query(query, params);

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
    runtime = "docker",
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

  if (RESERVED_SLUGS.has(projectSlug)) {
    return res.status(400).json({
      message: "Project name / domain prefix is reserved. Please choose another name.",
    });
  }

  if (!isValidRepoUrl(normalizedRepo)) {
    return res.status(400).json({
      message: "Please provide a valid HTTPS repository URL from GitHub, GitLab, or Bitbucket (e.g., https://github.com/organization/repository).",
    });
  }

  const trimmedBranch = String(branch || "main").trim();
  if (!isValidBranch(trimmedBranch)) {
    return res.status(400).json({
      message: "Invalid branch name. Must be 1-100 characters and cannot start with '-' or contain '..'.",
    });
  }

  const selectedRuntime = ALLOWED_RUNTIMES.includes(runtime) ? runtime : "docker";
  let internalPort = 3000;
  if (port !== undefined && port !== null && port !== "") {
    const parsedPort = Number(port);
    if (!Number.isInteger(parsedPort) || parsedPort < 1024 || parsedPort > 65535) {
      return res.status(400).json({
        message: "Internal container port must be an integer between 1024 and 65535.",
      });
    }
    internalPort = parsedPort;
  }
  const isAutoDeploy = autoDeploy !== undefined ? Boolean(autoDeploy) : Boolean(auto_deploy);
  const varsToSave = Array.isArray(envVars) ? envVars : Array.isArray(env_vars) ? env_vars : [];

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Check if user already has a project with this name
    const existing = await client.query(
      `SELECT id FROM projects WHERE user_id = $1 AND name = $2`,
      [req.user.id, projectSlug]
    );

    if (existing.rows.length > 0) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        message: `You already have a project named "${projectSlug}". Please choose a different name.`,
      });
    }

    const domainAlloc = await allocateDomain(client, projectSlug);
    if (domainAlloc.error) {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: domainAlloc.error });
    }
    const domain = domainAlloc.domain;

    const insertResult = await client.query(
      `INSERT INTO projects (
        user_id, name, repository_url, branch, runtime, port, auto_deploy, status, domain, latest_commit
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'INITIATED', $8, $9)
      RETURNING *`,
      [
        req.user.id,
        projectSlug,
        normalizedRepo,
        trimmedBranch,
        selectedRuntime,
        internalPort,
        isAutoDeploy,
        domain,
        "HEAD",
      ]
    );

    const newProject = insertResult.rows[0];

    // Atomically encrypt and save any initial environment variables into the vault
    if (Array.isArray(varsToSave) && varsToSave.length > 0) {
      if (varsToSave.length > 100) {
        await client.query("ROLLBACK");
        return res.status(400).json({ message: "Maximum limit of 100 environment variables per project." });
      }
      for (const item of varsToSave) {
        const rawKey = item.key;
        const rawVal = item.value ?? "";
        const key = String(rawKey || "").trim().toUpperCase();
        if (!key || !ENV_KEY_REGEX.test(key)) {
          await client.query("ROLLBACK");
          return res.status(400).json({ message: `Invalid variable key "${rawKey}".` });
        }
        if (BLOCKED_ENV_KEYS.has(key)) {
          await client.query("ROLLBACK");
          return res.status(400).json({ message: `Environment variable key "${key}" is reserved and not allowed.` });
        }
        if (typeof rawVal === "string" && Buffer.byteLength(rawVal, "utf8") > 8192) {
          await client.query("ROLLBACK");
          return res.status(400).json({ message: `Variable value for "${key}" exceeds maximum allowed size of 8 KB.` });
        }
        const isSecret = Boolean(item.isSecret !== undefined ? item.isSecret : item.is_secret);
        const enc = encrypt(String(rawVal));
        await client.query(
          `INSERT INTO project_env_vars (
            project_id, user_id, key, encrypted_value, iv, auth_tag, is_secret
          ) VALUES ($1, $2, $3, $4, $5, $6, $7)
          ON CONFLICT (project_id, key) DO UPDATE SET
            encrypted_value = EXCLUDED.encrypted_value,
            iv = EXCLUDED.iv,
            auth_tag = EXCLUDED.auth_tag,
            is_secret = EXCLUDED.is_secret,
            updated_at = NOW()`,
          [newProject.id, req.user.id, key, enc.ciphertext, enc.iv, enc.authTag, isSecret]
        );
      }
    }

    // Atomically create initial deployment with status INITIATED
    const initialDepRes = await client.query(
      `INSERT INTO deployments (
        project_id, user_id, commit_hash, commit_message, branch, status, trigger, environment, url
      ) VALUES ($1, $2, $3, $4, $5, 'INITIATED', 'initial', 'production', $6)
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

    const initDep = initialDepRes.rows[0];

    // Atomically insert Outbox Event (guaranteed delivery to Redis)
    const outboxPayload = {
      deployment_id: initDep.id,
      project_id: newProject.id,
      user_id: req.user.id,
      repo_url: newProject.repository_url,
      branch: newProject.branch,
      commit_hash: newProject.latest_commit || "HEAD",
      runtime: newProject.runtime,
      port: newProject.port,
      trigger: "initial",
      domain: newProject.domain,
      project_name: newProject.name,
      deployment_number: initDep.deployment_number,
    };

    await client.query(
      `INSERT INTO outbox_events (
        aggregate_type, aggregate_id, event_type, payload, status
      ) VALUES ('DEPLOYMENT', $1, 'DEPLOYMENT_INITIATED', $2::jsonb, 'PENDING')`,
      [initDep.id, JSON.stringify(outboxPayload)]
    );

    await client.query("COMMIT");

    // Immediate post-commit trigger for sub-millisecond dispatch
    triggerOutboxRelay();

    return res.status(201).json({
      message: `Project ${projectSlug} created successfully.`,
      project: formatProject(newProject),
    });
  } catch (error) {
    await client.query("ROLLBACK");
    if (error.code === "23505") {
      if (error.constraint === "uq_projects_domain") {
        return res.status(409).json({
          message: "Domain collision occurred. Please choose a different name or try again.",
        });
      }
      return res.status(409).json({
        message: `You already have a project named "${projectSlug}". Please choose a different name.`,
      });
    }
    console.error("Failed to create project:", error);
    return res.status(500).json({ message: "Unable to create project right now." });
  } finally {
    client.release();
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

  if (req.body && req.body.status !== undefined) {
    return res.status(400).json({ message: "Cannot modify project status directly." });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const check = await client.query(
      `SELECT * FROM projects WHERE id = $1 AND user_id = $2`,
      [id, req.user.id]
    );

    if (check.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "Project not found." });
    }

    const current = check.rows[0];
    const {
      name,
      repository_url,
      repoUrl,
      branch,
      runtime,
      port,
      auto_deploy,
      autoDeploy,
      env_vars,
      envVars,
    } = req.body;

    let newName = current.name;
    let newDomain = current.domain;
    if (name !== undefined) {
      const sanitized = sanitizeProjectName(name);
      if (!sanitized || sanitized.length < 2) {
        await client.query("ROLLBACK");
        return res.status(400).json({ message: "Invalid project name." });
      }
      if (RESERVED_SLUGS.has(sanitized)) {
        await client.query("ROLLBACK");
        return res.status(400).json({
          message: "Project name / domain prefix is reserved. Please choose another name.",
        });
      }
      if (sanitized !== current.name) {
        const dup = await client.query(
          `SELECT id FROM projects WHERE user_id = $1 AND name = $2 AND id != $3`,
          [req.user.id, sanitized, id]
        );
        if (dup.rows.length > 0) {
          await client.query("ROLLBACK");
          return res.status(409).json({ message: `Project named "${sanitized}" already exists.` });
        }
        newName = sanitized;
        const domainAlloc = await allocateDomain(client, sanitized, id);
        if (domainAlloc.error) {
          await client.query("ROLLBACK");
          return res.status(400).json({ message: domainAlloc.error });
        }
        newDomain = domainAlloc.domain;
      }
    }

    let newRepo = current.repository_url;
    const rawRepo = repository_url !== undefined ? repository_url : repoUrl;
    if (rawRepo !== undefined) {
      const normalizedRepo = normalizeRepoUrl(rawRepo);
      if (!isValidRepoUrl(normalizedRepo)) {
        await client.query("ROLLBACK");
        return res.status(400).json({
          message: "Please provide a valid HTTPS repository URL from GitHub, GitLab, or Bitbucket (e.g., https://github.com/organization/repository).",
        });
      }
      newRepo = normalizedRepo;
    }

    let newBranch = current.branch;
    if (branch !== undefined) {
      const trimmedBranch = String(branch).trim();
      if (!isValidBranch(trimmedBranch)) {
        await client.query("ROLLBACK");
        return res.status(400).json({
          message: "Invalid branch name. Must be 1-100 characters and cannot start with '-' or contain '..'.",
        });
      }
      newBranch = trimmedBranch;
    }

    const newRuntime = runtime !== undefined && ALLOWED_RUNTIMES.includes(runtime) ? runtime : current.runtime;
    let newPort = current.port;
    if (port !== undefined) {
      const parsedPort = Number(port);
      if (
        port === null ||
        typeof port === "boolean" ||
        (typeof port === "string" && port.trim() === "") ||
        !Number.isInteger(parsedPort) ||
        parsedPort < 1 ||
        parsedPort > 65535
      ) {
        await client.query("ROLLBACK");
        return res.status(400).json({
          message: "Internal container port must be an integer between 1 and 65535.",
        });
      }
      newPort = parsedPort;
    }
    const newAutoDeploy =
      autoDeploy !== undefined
        ? Boolean(autoDeploy)
        : auto_deploy !== undefined
        ? Boolean(auto_deploy)
        : current.auto_deploy;

    const updateResult = await client.query(
      `UPDATE projects
       SET name = $1,
           domain = $2,
           branch = $3,
           runtime = $4,
           port = $5,
           auto_deploy = $6,
           repository_url = $7,
           updated_at = NOW()
       WHERE id = $8 AND user_id = $9
       RETURNING *`,
      [newName, newDomain, newBranch, newRuntime, newPort, newAutoDeploy, newRepo, id, req.user.id]
    );

    const varsSource = envVars !== undefined ? envVars : env_vars;
    if (Array.isArray(varsSource)) {
      if (varsSource.length > 100) {
        await client.query("ROLLBACK");
        return res.status(400).json({ message: "Maximum limit of 100 environment variables per project." });
      }
      for (const item of varsSource) {
        const rawKey = item.key;
        const rawVal = item.value ?? "";
        const key = String(rawKey || "").trim().toUpperCase();
        if (!key || !ENV_KEY_REGEX.test(key)) {
          await client.query("ROLLBACK");
          return res.status(400).json({ message: `Invalid variable key "${rawKey}".` });
        }
        if (BLOCKED_ENV_KEYS.has(key)) {
          await client.query("ROLLBACK");
          return res.status(400).json({ message: `Environment variable key "${key}" is reserved and not allowed.` });
        }
        if (Buffer.byteLength(String(rawVal), "utf8") > 8192) {
          await client.query("ROLLBACK");
          return res.status(400).json({ message: `Variable value for "${key}" exceeds maximum allowed size of 8 KB.` });
        }
        const isSecret = Boolean(item.isSecret !== undefined ? item.isSecret : item.is_secret);
        const enc = encrypt(String(rawVal));
        await client.query(
          `INSERT INTO project_env_vars (
            project_id, user_id, key, encrypted_value, iv, auth_tag, is_secret
          ) VALUES ($1, $2, $3, $4, $5, $6, $7)
          ON CONFLICT (project_id, key) DO UPDATE SET
            encrypted_value = EXCLUDED.encrypted_value,
            iv = EXCLUDED.iv,
            auth_tag = EXCLUDED.auth_tag,
            is_secret = EXCLUDED.is_secret,
            updated_at = NOW()`,
          [id, req.user.id, key, enc.ciphertext, enc.iv, enc.authTag, isSecret]
        );
      }
    }

    await client.query("COMMIT");

    return res.status(200).json({
      message: "Project updated successfully.",
      project: formatProject(updateResult.rows[0]),
    });
  } catch (error) {
    await client.query("ROLLBACK");
    if (error.code === "23505") {
      return res.status(409).json({ message: "A collision occurred with the project name or domain." });
    }
    console.error("Failed to update project:", error);
    return res.status(500).json({ message: "Unable to update project." });
  } finally {
    client.release();
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

router.allocateDomain = allocateDomain;
router.RESERVED_SLUGS = RESERVED_SLUGS;

module.exports = router;
