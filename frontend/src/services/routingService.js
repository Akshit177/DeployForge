/**
 * Routing & Ingress API Service
 * Interacts with backend/routes/routing.js and Nginx proxy router
 */
import apiClient from "./apiClient.js";

/**
 * Retrieve the active upstream routing table and generated Nginx configuration
 * GET /api/routing/table
 */
export async function getRoutes(options = {}) {
  const data = await apiClient.get("/api/routing/table", options);
  return {
    active_routes_count: data.active_routes_count || (data.routes ? data.routes.length : 0),
    routes: data.routes || [],
    nginx_config: data.nginx_config || "",
  };
}

/**
 * Test domain resolution against the dynamic routing table
 * GET /api/routing/resolve/:domain
 */
export async function resolveRoute(domain, options = {}) {
  return apiClient.get(`/api/routing/resolve/${encodeURIComponent(domain)}`, options);
}

/**
 * Run an on-demand container health check probe for a project
 * GET /api/routing/health/:projectId
 */
export async function verifyDomainHealth(projectId, options = {}) {
  return apiClient.get(`/api/routing/health/${encodeURIComponent(projectId)}`, options);
}

/**
 * Update or register an upstream route for a domain
 * PUT /api/routing/:domain
 */
export async function updateRoute(domain, routeInfo, options = {}) {
  return apiClient.put(`/api/routing/${encodeURIComponent(domain)}`, routeInfo, options);
}

export default {
  getRoutes,
  resolveRoute,
  verifyDomainHealth,
  updateRoute,
};
