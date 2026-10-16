import apiClient from "./apiClient.js";

export async function fetchDeployments(params = {}, options = {}) {
  const query = new URLSearchParams();
  if (params.project_id) query.set("project_id", params.project_id);
  if (params.status) query.set("status", params.status);
  if (params.limit) query.set("limit", params.limit);

  const qs = query.toString() ? `?${query.toString()}` : "";
  const result = await apiClient.get(`/api/deployments${qs}`, options);
  return result.deployments || [];
}

export async function getDeployment(id, options = {}) {
  const result = await apiClient.get(`/api/deployments/${id}`, options);
  return result.deployment;
}

export async function triggerDeployment(payload, options = {}) {
  const result = await apiClient.post("/api/deployments", payload, options);
  return result.deployment;
}

export async function cancelDeployment(id, options = {}) {
  const result = await apiClient.post(`/api/deployments/${id}/cancel`, null, options);
  return result.deployment;
}

export async function stopDeployment(id, options = {}) {
  const result = await apiClient.post(`/api/deployments/${id}/stop`, null, options);
  return result.deployment;
}

export async function deleteDeployment(id, options = {}) {
  const result = await apiClient.delete(`/api/deployments/${id}`, options);
  return result;
}

export default {
  fetchDeployments,
  getDeployment,
  triggerDeployment,
  cancelDeployment,
  stopDeployment,
  deleteDeployment,
};
