import { createHmac } from 'crypto';
import path from 'path';

export const API = process.env.API_URL ?? 'http://localhost:4000';
export const FIXED_OTP = process.env.OTP_FIXED_CODE ?? '123456';

export function randomPhone(): string { return `09${Math.floor(10000000 + Math.random() * 89999999)}`.slice(0, 10); }

export async function apiCall<T = any>(method: string, p: string, token?: string | null, body?: unknown, extra: Record<string, string> = {}): Promise<{ status: number; body: T }> {
  const res = await fetch(`${API}/v1${p}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...extra }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : {}) as T };
}

export async function hostLogin(phone = randomPhone()) {
  await apiCall('POST', '/auth/request-otp', null, { phone });
  const r = await apiCall<any>('POST', '/auth/verify-otp', null, { phone, code: FIXED_OTP });
  return { phone, token: r.body.access_token as string, userId: r.body.user.id as string };
}

export async function makeEvent(token: string, over: Record<string, unknown> = {}) {
  const now = Date.now();
  const c = await apiCall<any>('POST', '/events', token, { name: 'ሠርግ Abebe & Sara', type: 'wedding', city: 'Addis Ababa', language: 'en', host_name: 'Abebe', starts_at: new Date(now - 3600_000).toISOString(), ends_at: new Date(now + 6 * 3600_000).toISOString(), upload_closes_at: new Date(now + 24 * 3600_000).toISOString(), ...over });
  if (c.status !== 201) throw new Error(JSON.stringify(c.body));
  const t = await apiCall('POST', `/events/${c.body.id}/activate-trial`, token, {}); if (t.status !== 200) throw new Error(JSON.stringify(t.body));
  const l = (await apiCall<any>('GET', `/events/${c.body.id}/share-links`, token)).body;
  return { id: c.body.id as string, uploadUrl: l.upload_url as string, galleryUrl: l.gallery_url as string, code: l.join_code as string };
}

/** A real, photo-like JPEG (via sharp from the API workspace). */
export async function jpeg(seed = 1, w = 1600, h = 1200): Promise<Buffer> {
  const sharp = require(path.resolve(__dirname, '../../api/node_modules/sharp'));
  const raw = Buffer.alloc(w * h * 3); let s = seed * 2654435761 >>> 0;
  for (let i = 0; i < raw.length; i += 3) { s = (s * 1664525 + 1013904223) >>> 0; const x = (i / 3) % w; const y = Math.floor(i / 3 / w); raw[i] = ((x * 255) / w + (s >>> 25)) % 256; raw[i + 1] = ((y * 255) / h + ((s >>> 17) & 63)) % 256; raw[i + 2] = (x + y + seed * 13) % 256; }
  return sharp(raw, { raw: { width: w, height: h, channels: 3 } }).jpeg({ quality: 82 }).toBuffer();
}

export async function approveAll(token: string, eventId: string) {
  const q = await apiCall<any>('GET', `/events/${eventId}/moderation`, token);
  const ids = q.body.items.map((i: any) => i.id);
  if (ids.length) await apiCall('POST', `/events/${eventId}/moderation/bulk`, token, { action: 'approve', media_ids: ids });
  return ids.length as number;
}

// RFC 6238 TOTP for the admin 2FA screens
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function totp(secretB32: string, now = Date.now()): string {
  let bits = 0, val = 0; const out: number[] = [];
  for (const ch of secretB32.toUpperCase()) { const i = B32.indexOf(ch); if (i < 0) continue; val = (val << 5) | i; bits += 5; if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; } }
  const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(Math.floor(now / 30000)));
  const h = createHmac('sha1', Buffer.from(out)).update(msg).digest(); const off = h[h.length - 1] & 0xf;
  return String((((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3]) % 1_000_000).padStart(6, '0');
}

/** Path+query of an absolute link, so tests work whatever port the web app runs on. */
export const rel = (u: string) => { const x = new URL(u); return x.pathname + x.search; };
