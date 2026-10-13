const express = require("express");
const { authenticateToken } = require("../middleware/auth.js");
const { getRoutingTable, generateNginxConfig, resolveDomain } = require("../services/proxyRouter.js");
const { checkProjectHealth } = require("../services/healthCheck.js");

const router = express.Router();

/**
 * GET /api/routing/table
 * Inspect the active reverse proxy upstream routing table and generated Nginx configuration
 */
router.get("/table", (req, res) => {
  const routes = getRoutingTable();
  const nginxConfig = generateNginxConfig();

  return res.status(200).json({
    active_routes_count: routes.length,
    routes,
    nginx_config: nginxConfig,
  });
});

/**
 * GET /api/routing/resolve/:domain
 * Test domain resolution against the dynamic routing table
 */
router.get("/resolve/:domain", (req, res) => {
  const { domain } = req.params;
  const match = resolveDomain(domain);

  if (!match) {
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
});

/**
 * GET /api/routing/health/:projectId
 * Run an on-demand container health check probe for a project's active deployment
 */
router.get("/health/:projectId", authenticateToken, async (req, res) => {
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

module.exports = router;
