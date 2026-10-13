async function sendAuthRequest(endpoint, payload, method = "POST") {
  const options = {
    method,
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
  };
  if (payload) {
    options.body = JSON.stringify(payload);
  }

  const response = await fetch(`/api/auth/${endpoint}`, options);
  const result = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(result.message || "The request could not be completed.");
  }

  return result;
}

export function login(credentials) {
  return sendAuthRequest("login", credentials);
}

export function register(account) {
  return sendAuthRequest("register", account);
}

export function logout() {
  return sendAuthRequest("logout", null, "POST");
}

export async function getCurrentUser() {
  const response = await fetch("/api/auth/me", {
    credentials: "same-origin",
  });
  if (!response.ok) {
    return null;
  }
  const data = await response.json();
  return data.user || null;
}
