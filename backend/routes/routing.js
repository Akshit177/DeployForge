const express = require("express");
const pool = require("../config/db.js");
const { authenticateToken } = require("../middleware/auth.js");
const {
  getRoutingTable,
  resolveDomain,
  registerUpstreamRoute,
  syncFromDatabase,
  syncFromDatabaseThrottled,
  normalizeDomainKey,
} = require("../services/proxyRouter.js");
const { checkProjectHealth } = require("../services/healthCheck.js");

const router = express.Router();
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Require authentication across all routing endpoints
router.use(authenticateToken);

/**
 * GET /api/routing/table
 * Inspect the active reverse proxy upstream routing table scoped to caller's projects
 */
router.get("/table", async (req, res) => {
  try {
    const userProjects = await pool.query(
      "SELECT id FROM projects WHERE user_id = $1",
      [req.user.id]
    );
    const allowedProjectIds = new Set(userProjects.rows.map((r) => r.id));

    let routes = getRoutingTable().filter((r) =>
      allowedProjectIds.has(r.project_id)
    );

    if (routes.length === 0 && allowedProjectIds.size > 0) {
      await syncFromDatabaseThrottled();
      routes = getRoutingTable().filter((r) =>
        allowedProjectIds.has(r.project_id)
      );
    }

    return res.status(200).json({
      active_routes_count: routes.length,
      routes,
    });
  } catch (err) {
    console.error("Failed to fetch routing table:", err);
    return res.status(500).json({ message: "Failed to retrieve routing table." });
  }
});

/**
 * GET /api/routing/resolve/:domain
 * Test domain resolution against the dynamic routing table for caller's own projects
 */
router.get("/resolve/:domain", async (req, res) => {
  const { domain } = req.params;
  let match = resolveDomain(domain);
  if (!match) {
    await syncFromDatabaseThrottled();
    match = resolveDomain(domain);
  }

  if (!match) {
    return res.status(404).json({
      matched: false,
      message: `Domain ${domain} is not currently routed to any active upstream container.`,
    });
  }

  try {
    const userProjects = await pool.query(
      "SELECT id FROM projects WHERE id = $1 AND user_id = $2",
      [match.project_id, req.user.id]
    );

    if (userProjects.rows.length === 0) {
      return res.status(404).json({
        matched: false,
        message: `Domain ${domain} is not currently routed to any active upstream container.`,
      });
    }

    return res.status(200).json({
      matched: true,
      route: match,
      target_upstream: `http://${match.target_host}:${match.port}`,
    });
  } catch (err) {
    console.error("Failed to resolve route:", err);
    return res.status(500).json({ message: "Failed to resolve route." });
  }
});

/**
 * GET /api/routing/health/:projectId
 * Run an on-demand container health check probe for a project's active deployment
 */
router.get("/health/:projectId", async (req, res) => {
  const { projectId } = req.params;

  if (!UUID_REGEX.test(projectId)) {
    return res.status(404).json({ message: "Project not found" });
  }

  try {
    const health = await checkProjectHealth(projectId, req.user.id);
    if (health.error) {
      return res.status(health.status || 404).json({ message: health.error });
    }

    return res.status(200).json(health);
  } catch (err) {
    console.error("Health probe error:", err);
    return res.status(500).json({ message: "Failed to probe project health." });
  }
});

/**
 * PUT /api/routing/:domain
 * Re-register the upstream route of one of the caller's OWN projects.
 *
 * The upstream is derived server-side from the project's currently RUNNING deployment. The
 * request body is never trusted for `target_host` / `project_id` / `deployment_id`: letting
 * clients choose those allowed hijacking other tenants' domains, proxying to internal hosts
 * (SSRF) and injecting arbitrary text into the generated nginx config. Only an optional
 * `port` override is honoured.
 */
router.put("/:domain", async (req, res) => {
  const cleanDomain = normalizeDomainKey(req.params.domain);
  const body = req.body && typeof req.body === "object" ? req.body : {};

  try {
    if (!cleanDomain) {
      return res.status(400).json({ message: "A valid domain is required." });
    }

    const projectResult = await pool.query(
      "SELECT id, name, domain, port FROM projects WHERE LOWER(domain) = $1 AND user_id = $2",
      [cleanDomain, req.user.id]
    );
    if (projectResult.rows.length === 0) {
      return res.status(404).json({ message: "Domain not found." });
    }
    const project = projectResult.rows[0];

    let port = project.port || 3000;
    if (body.port !== undefined && body.port !== null && body.port !== "") {
      port = Number(body.port);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        return res.status(400).json({ message: "Port must be an integer between 1 and 65535." });
      }
    }

    const deployment = await pool.query(
      `SELECT id, container_id, container_name
       FROM deployments
       WHERE project_id = $1 AND UPPER(status) = 'RUNNING'
       ORDER BY created_at DESC LIMIT 1`,
      [project.id]
    );
    if (deployment.rows.length === 0) {
      return res.status(409).json({ message: "Project has no running deployment to route to." });
    }
    const dep = deployment.rows[0];
    const containerName = dep.container_name || `df-${dep.id.replace(/-/g, "").slice(0, 12)}`;

    const updated = registerUpstreamRoute(project.domain, {
      project_id: project.id,
      project_name: project.name,
      deployment_id: dep.id,
      container_id: dep.container_id,
      container_name: containerName,
      target_host: containerName,
      port,
    });

    if (!updated) {
      return res.status(400).json({ message: "Route could not be registered." });
    }

    return res.status(200).json({
      success: true,
      route: updated,
    });
  } catch (err) {
    console.error("Failed to update route:", err);
    return res.status(500).json({ message: "Failed to update route." });
  }
});

module.exports = router;
