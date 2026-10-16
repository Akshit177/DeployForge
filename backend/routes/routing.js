const express = require("express");
const pool = require("../config/db.js");
const { authenticateToken } = require("../middleware/auth.js");
const { getRoutingTable, resolveDomain, registerUpstreamRoute, syncFromDatabase } = require("../services/proxyRouter.js");
const { checkProjectHealth } = require("../services/healthCheck.js");

const router = express.Router();

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
      await syncFromDatabase();
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
    await syncFromDatabase();
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
 * Register or update an upstream route for a domain
 */
router.put("/:domain", async (req, res) => {
  const { domain } = req.params;
  const routeInfo = req.body || {};
  try {
    const updated = registerUpstreamRoute(domain, routeInfo);
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
