import apiClient from "./apiClient.js";

export async function fetchEnvVars(projectId, options = {}, fetchOptions = {}) {
  const query = new URLSearchParams();
  if (options.reveal) query.set("reveal", "true");
  const qs = query.toString() ? `?${query.toString()}` : "";
  const result = await apiClient.get(`/api/projects/${projectId}/env${qs}`, fetchOptions);
  return result.env_vars || [];
}

export async function saveEnvVars(projectId, vars, options = {}) {
  const result = await apiClient.post(`/api/projects/${projectId}/env`, vars, options);
  return result.env_vars || [];
}

export async function deleteEnvVar(projectId, keyOrId, options = {}) {
  return apiClient.delete(`/api/projects/${projectId}/env/${encodeURIComponent(keyOrId)}`, options);
}

export default {
  fetchEnvVars,
  saveEnvVars,
  deleteEnvVar,
};
