async function sendAuthRequest(endpoint, payload) {
  const response = await fetch(`/api/auth/${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify(payload),
  });
  const result = await response.json();

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
