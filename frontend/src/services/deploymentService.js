async function request(endpoint, options = {}) {
  const url = `/api/deployments${endpoint}`;
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

export async function fetchDeployments(params = {}) {
  const query = new URLSearchParams();
  if (params.project_id) query.set("project_id", params.project_id);
  if (params.status) query.set("status", params.status);
  if (params.limit) query.set("limit", params.limit);

  const qs = query.toString() ? `?${query.toString()}` : "";
  const result = await request(qs);
  return result.deployments || [];
}

export async function getDeployment(id) {
  const result = await request(`/${id}`);
  return result.deployment;
}

export async function triggerDeployment(payload) {
  const result = await request("", {
    method: "POST",
    body: JSON.stringify(payload),
  });
  return result.deployment;
}

export async function cancelDeployment(id) {
  const result = await request(`/${id}/cancel`, {
    method: "POST",
  });
  return result.deployment;
}

export async function updateDeploymentStatus(id, payload) {
  const result = await request(`/${id}/status`, {
    method: "PATCH",
    body: JSON.stringify(payload),
  });
  return result.deployment;
}
