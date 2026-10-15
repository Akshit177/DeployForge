import apiClient from "./apiClient.js";

export async function fetchProjects(options = {}) {
  const result = await apiClient.get("/api/projects", options);
  return result.projects || [];
}

export async function createProject(payload, options = {}) {
  const result = await apiClient.post("/api/projects", payload, options);
  return result.project;
}

export async function getProject(id, options = {}) {
  const result = await apiClient.get(`/api/projects/${id}`, options);
  return result.project;
}

export async function updateProject(id, payload, options = {}) {
  const result = await apiClient.patch(`/api/projects/${id}`, payload, options);
  return result.project;
}

export async function deleteProject(id, options = {}) {
  return apiClient.delete(`/api/projects/${id}`, options);
}

export default {
  fetchProjects,
  createProject,
  getProject,
  updateProject,
  deleteProject,
};
