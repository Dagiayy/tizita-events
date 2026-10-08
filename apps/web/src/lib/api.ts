/**
 * Typed API client. Same-origin by default (`/v1` is proxied by nginx or the Next.js rewrite);
 * set NEXT_PUBLIC_API_BASE for split-origin development. Never talks to storage or payment providers directly.
 */
export const API_BASE = (process.env.NEXT_PUBLIC_API_BASE ?? '').replace(/\/$/, '');

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: any, public requestId?: string) { super(message); }
  get isNetwork() { return this.status === 0; }
}

export async function request<T = any>(path: string, init: RequestInit & { token?: string | null; json?: unknown; web?: boolean } = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.token) headers.set('Authorization', `Bearer ${init.token}`);
  if (init.json !== undefined) { headers.set('Content-Type', 'application/json'); init.body = JSON.stringify(init.json); }
  if (init.web) headers.set('X-Client-Kind', 'web');
  let res: Response;
  try {
    res = await fetch(`${API_BASE}/v1${path}`, { ...init, headers, credentials: init.web ? 'include' : 'same-origin' });
  } catch {
    throw new ApiError(0, 'network', 'network error');
  }
  if (res.status === 204) return undefined as T;
  const ct = res.headers.get('content-type') ?? '';
  if (!res.ok) {
    const body = ct.includes('json') ? await res.json().catch(() => ({})) : {};
    const e = body?.error ?? {};
    throw new ApiError(res.status, e.code ?? 'http_error', e.message ?? res.statusText, e.details, e.request_id);
  }
  if (ct.includes('json')) return res.json() as Promise<T>;
  return (await res.blob()) as unknown as T;
}

// ---------------------------------------------------------------------------- host / staff session (access token in memory, refresh in HttpOnly cookie)
let accessToken: string | null = null;
let refreshing: Promise<string | null> | null = null;
const listeners = new Set<(signedIn: boolean) => void>();
export const onAuthChange = (fn: (s: boolean) => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
const emit = () => listeners.forEach((l) => l(!!accessToken));

export function setAccessToken(t: string | null) { accessToken = t; emit(); }
export const getAccessToken = () => accessToken;

export async function refreshSession(): Promise<string | null> {
  if (!refreshing) {
    refreshing = request<{ access_token: string }>('/auth/refresh', { method: 'POST', json: {}, web: true })
      .then((r) => { setAccessToken(r.access_token); return r.access_token; })
      .catch(() => { setAccessToken(null); return null; })
      .finally(() => { refreshing = null; });
  }
  return refreshing;
}

/** Authenticated call with one transparent refresh on 401. */
export async function authed<T = any>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  if (!accessToken) await refreshSession();
  try {
    return await request<T>(path, { ...init, token: accessToken, web: true });
  } catch (e) {
    if (e instanceof ApiError && e.status === 401 && (await refreshSession())) return request<T>(path, { ...init, token: accessToken, web: true });
    throw e;
  }
}

export const api = {
  get: <T = any>(p: string) => authed<T>(p),
  post: <T = any>(p: string, json: unknown = {}, headers?: Record<string, string>) => authed<T>(p, { method: 'POST', json, headers }),
  patch: <T = any>(p: string, json: unknown) => authed<T>(p, { method: 'PATCH', json }),
  put: <T = any>(p: string, json: unknown) => authed<T>(p, { method: 'PUT', json }),
  del: <T = any>(p: string) => authed<T>(p, { method: 'DELETE' }),
  /** Uploads a single image as the raw request body (event cover). */
  putImage: <T = any>(p: string, file: File) => authed<T>(p, { method: 'PUT', body: file, headers: { 'Content-Type': file.type } }),
};

export async function logout() {
  try { await authed('/auth/logout', { method: 'POST', json: {} }); } catch { /* already gone */ }
  setAccessToken(null);
}

/** Binary POST (QR images/PDF): returns a Blob and filename. */
export async function authedBlob(path: string, json: unknown): Promise<Blob> {
  if (!accessToken) await refreshSession();
  const res = await fetch(`${API_BASE}/v1${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}`, 'X-Client-Kind': 'web' }, body: JSON.stringify(json), credentials: 'include' });
  if (!res.ok) { const b = await res.json().catch(() => ({})); throw new ApiError(res.status, b?.error?.code ?? 'http_error', b?.error?.message ?? 'error'); }
  return res.blob();
}

// ---------------------------------------------------------------------------- guest session helpers
export interface GuestSession { token: string; scopes: ('upload' | 'gallery')[]; display_name?: string | null; expiresAt: number }
const gKey = (locator: string) => `ep.guest.${locator.slice(0, 12)}.${hash(locator)}`;
function hash(s: string) { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return (h >>> 0).toString(36); }
export function loadGuest(locator: string): GuestSession | null {
  try { const raw = localStorage.getItem(gKey(locator)); if (!raw) return null; const g = JSON.parse(raw) as GuestSession; return g.expiresAt > Date.now() ? g : null; } catch { return null; }
}
export function saveGuest(locator: string, g: GuestSession) { try { localStorage.setItem(gKey(locator), JSON.stringify(g)); } catch { /* private mode: session lives in memory only */ } }
export function clearGuest(locator: string) { try { localStorage.removeItem(gKey(locator)); } catch { /* ignore */ } }

export function guestFetch<T = any>(session: GuestSession, path: string, init: RequestInit & { json?: unknown } = {}) {
  return request<T>(path, { ...init, token: session.token });
}

export const formatBytes = (n: number) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/** Server-driven UI flags, filled in by the admin gate after sign-in. */
export const flags = { adminMfa: true };
/** True when a step-up code is not needed (MFA off) or the entered 6-digit code is complete. */
export const stepUpOk = (code: string) => !flags.adminMfa || code.length === 6;
