async function request(projectId, endpoint = "", options = {}) {
  const url = `/api/projects/${projectId}/env${endpoint}`;
  const response = await fetch(url, {
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
    ...options,
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.message || `Request failed with status ${response.status}`);
  }

  return data;
}

export async function fetchEnvVars(projectId, options = {}) {
  const query = new URLSearchParams();
  if (options.reveal) query.set("reveal", "true");
  const qs = query.toString() ? `?${query.toString()}` : "";
  const result = await request(projectId, qs);
  return result.env_vars || [];
}

export async function saveEnvVars(projectId, vars) {
  const result = await request(projectId, "", {
    method: "POST",
    body: JSON.stringify(vars),
  });
  return result.env_vars || [];
}

export async function deleteEnvVar(projectId, keyOrId) {
  return request(projectId, `/${encodeURIComponent(keyOrId)}`, {
    method: "DELETE",
  });
}
