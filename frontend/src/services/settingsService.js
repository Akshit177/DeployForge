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

/**
 * Validate GitHub profile link or handle
 * @param {string} rawInput - e.g. "https://github.com/torvalds" or "torvalds" or "@torvalds"
 * @returns {{ valid: boolean, username?: string, profileUrl?: string, error?: string }}
 */
export function validateGitHubProfile(rawInput) {
  if (!rawInput || typeof rawInput !== "string") {
    return { valid: false, error: "Please enter a GitHub profile link or handle." };
  }

  let cleaned = rawInput.trim();

  // If protocol URL provided
  if (/^https?:\/\//i.test(cleaned)) {
    try {
      const parsed = new URL(cleaned);
      const host = parsed.hostname.toLowerCase();
      if (host !== "github.com" && host !== "www.github.com") {
        return {
          valid: false,
          error: `Invalid domain "${parsed.hostname}". Only GitHub profile links (https://github.com/username) are supported.`,
        };
      }

      const segments = parsed.pathname.split("/").filter(Boolean);
      if (segments.length === 0) {
        return { valid: false, error: "GitHub URL must include a username (e.g., https://github.com/username)." };
      }
      if (segments.length > 1) {
        return {
          valid: false,
          error: `"${parsed.pathname}" appears to be a repository or sub-path. Please provide a profile link like https://github.com/${segments[0]}.`,
        };
      }

      cleaned = segments[0];
    } catch {
      return { valid: false, error: "Malformed URL. Expected format: https://github.com/username" };
    }
  } else {
    // Strip leading @ or trailing slashes
    if (cleaned.startsWith("@")) {
      cleaned = cleaned.slice(1);
    }
    cleaned = cleaned.replace(/\/+$/, "");
  }

  // GitHub username specifications:
  // - 1 to 39 characters
  // - May only contain alphanumeric characters or single hyphens
  // - Cannot begin or end with a hyphen
  const GITHUB_USERNAME_REGEX = /^[a-zA-Z0-9](?:[a-zA-Z0-9]|-(?=[a-zA-Z0-9])){0,38}$/;
  if (!GITHUB_USERNAME_REGEX.test(cleaned)) {
    if (cleaned.length > 39) {
      return { valid: false, error: "GitHub username cannot exceed 39 characters." };
    }
    if (cleaned.startsWith("-") || cleaned.endsWith("-")) {
      return { valid: false, error: "GitHub username cannot begin or end with a hyphen." };
    }
    if (cleaned.includes("--")) {
      return { valid: false, error: "GitHub username cannot contain consecutive hyphens." };
    }
    return {
      valid: false,
      error: `Invalid GitHub handle "${cleaned}". Usernames may only contain alphanumeric characters and single hyphens.`,
    };
  }

  return {
    valid: true,
    username: cleaned,
    profileUrl: `https://github.com/${cleaned}`,
  };
}

/**
 * Verify GitHub profile exists via public API (with graceful fallback on rate-limits)
 * @param {string} username
 * @returns {Promise<{ exists: boolean, avatarUrl?: string, error?: string }>}
 */
export async function verifyGitHubProfileExists(username) {
  try {
    const res = await fetch(`https://api.github.com/users/${encodeURIComponent(username)}`, {
      headers: { Accept: "application/vnd.github.v3+json" },
    });

    if (res.status === 200) {
      const data = await res.json();
      return { exists: true, avatarUrl: data.avatar_url, name: data.name };
    }

    if (res.status === 404) {
      return {
        exists: false,
        error: `GitHub user "@${username}" was not found. Please verify that this GitHub account exists.`,
      };
    }

    // Rate-limited (403) or other response: accept valid format gracefully
    return { exists: true };
  } catch (err) {
    // If offline or blocked by browser policy/extensions, fall back to format validation
    return { exists: true };
  }
}
