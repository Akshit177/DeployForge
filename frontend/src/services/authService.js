import apiClient from "./apiClient.js";

export async function login(credentials, options = {}) {
  const result = await apiClient.post("/api/auth/login", credentials, {
    skipAuthRedirect: true,
    ...options,
  });
  if (result && result.token) {
    try {
      localStorage.setItem("df_token", result.token);
      localStorage.setItem("token", result.token);
    } catch (_) {}
  }
  return result;
}

export async function register(account, options = {}) {
  const result = await apiClient.post("/api/auth/register", account, {
    skipAuthRedirect: true,
    ...options,
  });
  if (result && result.token) {
    try {
      localStorage.setItem("df_token", result.token);
      localStorage.setItem("token", result.token);
    } catch (_) {}
  }
  return result;
}

export async function logout(options = {}) {
  try {
    await apiClient.post("/api/auth/logout", null, {
      skipAuthRedirect: true,
      ...options,
    });
  } finally {
    try {
      localStorage.removeItem("df_token");
      localStorage.removeItem("token");
    } catch (_) {}
  }
}

export async function getCurrentUser(options = {}) {
  try {
    const data = await apiClient.get("/api/auth/me", {
      skipAuthRedirect: true,
      ...options,
    });
    return data.user || null;
  } catch (err) {
    // The session is gone: drop the stale token so it is not sent again
    if (err && err.status === 401) {
      try {
        localStorage.removeItem("df_token");
        localStorage.removeItem("token");
      } catch (_) {}
    }
    return null;
  }
}

export default {
  login,
  register,
  logout,
  getCurrentUser,
};
