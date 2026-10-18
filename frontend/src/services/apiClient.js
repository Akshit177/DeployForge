export function buildApiUrl(endpoint) {
  if (!endpoint) return '/api';
  if (endpoint.startsWith('http://') || endpoint.startsWith('https://')) {
    return endpoint;
  }

  const base = ((typeof import.meta !== 'undefined' && import.meta.env?.VITE_API_URL) || '').replace(/\/+$/, '');
  const cleanEndpoint = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;

  if (!base) {
    // Relative request (e.g. served by backend on port 3000 or proxied by Vite)
    if (cleanEndpoint.startsWith('/api/') || cleanEndpoint === '/api') {
      return cleanEndpoint;
    }
    return `/api${cleanEndpoint}`;
  }

  if (base.endsWith('/api')) {
    if (cleanEndpoint.startsWith('/api/') || cleanEndpoint === '/api') {
      return `${base}${cleanEndpoint.slice(4)}`;
    }
    return `${base}${cleanEndpoint}`;
  }

  if (cleanEndpoint.startsWith('/api/') || cleanEndpoint === '/api') {
    return `${base}${cleanEndpoint}`;
  }

  return `${base}/api${cleanEndpoint}`;
}

export const API_BASE_URL = buildApiUrl('/api');

export class ApiError extends Error {
  constructor(message, status = 500, data = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.data = data;
    this.code = (data && data.code) || (status === 401 ? 'UNAUTHORIZED' : `HTTP_${status}`);
  }
}

export async function apiRequest(endpoint, rawOptions = {}) {
  // `skipAuthRedirect` is a client-side flag (e.g. a wrong password on /login is also a 401 but
  // must not be treated as an expired session); it must not be forwarded to fetch().
  const { skipAuthRedirect = false, ...options } = rawOptions;
  const token =
    (typeof window !== 'undefined' &&
      (localStorage.getItem('df_token') || localStorage.getItem('token'))) ||
    null;
  const headers = new Headers(options.headers || {});

  if (!headers.has('Content-Type') && !(options.body instanceof FormData)) {
    headers.set('Content-Type', 'application/json');
  }

  if (token && !headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${token}`);
  }

  const config = {
    credentials: options.credentials || 'include',
    ...options,
    headers,
  };

  if (config.body && typeof config.body === 'object' && !(config.body instanceof FormData)) {
    config.body = JSON.stringify(config.body);
  }

  const url = buildApiUrl(endpoint);

  let response;
  try {
    response = await fetch(url, config);
  } catch (networkError) {
    if (networkError.name === 'AbortError') {
      throw networkError;
    }
    throw new ApiError(networkError.message || 'Network request failed', 0, null);
  }

  let payload = null;
  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    payload = await response.json().catch(() => null);
  } else {
    payload = await response.text().catch(() => null);
  }

  // The API re-issues a fresh access token shortly before the current one expires (sliding
  // session). The cookie is updated automatically; keep the Bearer fallback in sync as well.
  const refreshedToken = response.headers.get('x-auth-token');
  if (refreshedToken && typeof window !== 'undefined') {
    localStorage.setItem('df_token', refreshedToken);
    localStorage.setItem('token', refreshedToken);
  }

  if (response.status === 401 && !skipAuthRedirect) {
    if (typeof window !== 'undefined') {
      localStorage.removeItem('df_token');
      localStorage.removeItem('token');
      window.dispatchEvent(
        new CustomEvent('auth:unauthorized', {
          detail: { status: 401, endpoint },
        })
      );
    }
  }

  if (!response.ok) {
    const message =
      (payload && (payload.error || payload.message)) ||
      `Request failed with status ${response.status}`;
    throw new ApiError(message, response.status, payload);
  }

  return payload;
}

export const apiClient = apiRequest;

apiClient.get = (url, options = {}) =>
  apiRequest(url, { ...options, method: 'GET' });

apiClient.post = (url, body, options = {}) =>
  apiRequest(url, { ...options, method: 'POST', body });

apiClient.put = (url, body, options = {}) =>
  apiRequest(url, { ...options, method: 'PUT', body });

apiClient.patch = (url, body, options = {}) =>
  apiRequest(url, { ...options, method: 'PATCH', body });

apiClient.delete = (url, options = {}) =>
  apiRequest(url, { ...options, method: 'DELETE' });

export default apiClient;
