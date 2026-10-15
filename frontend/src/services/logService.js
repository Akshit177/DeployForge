import apiClient, { buildApiUrl } from "./apiClient.js";

export async function fetchLogs(params = {}, options = {}) {
  const query = new URLSearchParams();
  if (params.deployment_id) query.set("deployment_id", params.deployment_id);
  if (params.project_id) query.set("project_id", params.project_id);
  if (params.level && params.level !== "All") query.set("level", params.level);
  if (params.limit) query.set("limit", params.limit);
  if (params.since) query.set("since", params.since);

  const qs = query.toString() ? `?${query.toString()}` : "";
  const data = await apiClient.get(`/api/logs${qs}`, options);
  return data.logs || [];
}

export function connectLogStream(params = {}, callbacks = {}) {
  const query = new URLSearchParams();
  if (params.deployment_id) query.set("deployment_id", params.deployment_id);
  if (params.project_id) query.set("project_id", params.project_id);

  const qs = query.toString() ? `?${query.toString()}` : "";
  const eventSource = new EventSource(buildApiUrl(`/api/logs/stream${qs}`), {
    withCredentials: true,
  });

  if (callbacks.onInit) {
    eventSource.addEventListener("init", (e) => {
      try {
        const parsed = JSON.parse(e.data);
        callbacks.onInit(parsed);
      } catch (err) {
        console.warn("Could not parse init logs payload:", err);
      }
    });
  }

  if (callbacks.onLog) {
    eventSource.addEventListener("log", (e) => {
      try {
        const parsed = JSON.parse(e.data);
        callbacks.onLog(parsed);
      } catch (err) {
        console.warn("Could not parse live log line:", err);
      }
    });
  }

  if (callbacks.onError) {
    eventSource.onerror = (err) => {
      callbacks.onError(err);
    };
  }

  return () => {
    eventSource.close();
  };
}

export default {
  fetchLogs,
  connectLogStream,
};
