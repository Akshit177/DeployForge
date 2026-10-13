/**
 * Settings & Account Security API Service
 */

export async function fetchSettings() {
  const response = await fetch("/api/settings", {
    credentials: "same-origin",
  });
  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.message || "Failed to load account settings");
  }
  return response.json();
}

export async function updateProfile(data) {
  const response = await fetch("/api/settings/profile", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify(data),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(result.message || "Failed to update profile");
  }
  return result;
}

export async function updatePassword(passwords) {
  const response = await fetch("/api/settings/password", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify(passwords),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(result.message || "Failed to update password");
  }
  return result;
}

export async function updateNotificationPreferences(prefs) {
  const response = await fetch("/api/settings/notifications", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify(prefs),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(result.message || "Failed to update notification preferences");
  }
  return result;
}

export async function fetchDomains() {
  const response = await fetch("/api/settings/domains", {
    credentials: "same-origin",
  });
  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.message || "Failed to load domains");
  }
  const data = await response.json();
  return data.domains || [];
}

export async function addDomain(domain, projectId = null) {
  const response = await fetch("/api/settings/domains", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify({ domain, project_id: projectId }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(result.message || "Failed to register custom domain");
  }
  return result.domain;
}

export async function deleteDomain(domainId) {
  const response = await fetch(`/api/settings/domains/${encodeURIComponent(domainId)}`, {
    method: "DELETE",
    credentials: "same-origin",
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(result.message || "Failed to delete custom domain");
  }
  return result;
}
