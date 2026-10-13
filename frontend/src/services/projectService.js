async function request(endpoint, options = {}) {
  const url = `/api/projects${endpoint}`;
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

export async function fetchProjects() {
  const result = await request("");
  return result.projects || [];
}

export async function createProject(payload) {
  const result = await request("", {
    method: "POST",
    body: JSON.stringify(payload),
  });
  return result.project;
}

export async function getProject(id) {
  const result = await request(`/${id}`);
  return result.project;
}

export async function updateProject(id, payload) {
  const result = await request(`/${id}`, {
    method: "PATCH",
    body: JSON.stringify(payload),
  });
  return result.project;
}

export async function deleteProject(id) {
  return request(`/${id}`, {
    method: "DELETE",
  });
}
