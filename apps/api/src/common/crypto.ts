import { Inject, Injectable } from '@nestjs/common';
import {
  createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomInt, scrypt as scryptCb, timingSafeEqual,
} from 'crypto';
import { promisify } from 'util';
import { AppConfig, CONFIG } from './config';

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number, opts: object) => Promise<Buffer>;

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
/** Unambiguous alphabet for human-typed short join codes (no 0/O/1/I/L). */
export const JOIN_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export const sha256Hex = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');
export const randomToken = (bytes = 32): string => randomBytes(bytes).toString('base64url');
export function randomFromAlphabet(alphabet: string, len: number): string {
  let out = '';
  for (let i = 0; i < len; i++) out += alphabet[randomInt(alphabet.length)];
  return out;
}
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

export function base32Encode(buf: Buffer): string {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
export function base32Decode(s: string): Buffer {
  let bits = 0, value = 0;
  const out: number[] = [];
  for (const ch of s.replace(/=+$/, '').toUpperCase()) {
    const idx = B32.indexOf(ch);
    if (idx < 0) continue;
    value = (value << 5) | idx; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

/** RFC 6238 TOTP (HMAC-SHA1, 30 s step, 6 digits) used for admin 2FA. */
export function totpAt(secretB32: string, step: number): string {
  const key = base32Decode(secretB32);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(step));
  const h = createHmac('sha1', key).update(msg).digest();
  const off = h[h.length - 1] & 0xf;
  const code = ((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3];
  return String(code % 1_000_000).padStart(6, '0');
}
/** Returns the matching step (for replay protection) or null. Accepts +-1 step of clock drift. */
export function totpVerify(secretB32: string, code: string, now = Date.now()): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const step = Math.floor(now / 30000);
  for (const s of [step, step - 1, step + 1]) if (safeEqual(totpAt(secretB32, s), code)) return s;
  return null;
}

@Injectable()
export class CryptoService {
  private readonly key: Buffer;
  constructor(@Inject(CONFIG) private readonly cfg: AppConfig) {
    this.key = Buffer.from(cfg.DATA_ENCRYPTION_KEY, 'base64');
    if (this.key.length !== 32) throw new Error('DATA_ENCRYPTION_KEY must be 32 bytes (base64)');
  }

  /** Keyed blind index (phone numbers, IPs, device ids, event tokens). Not reversible. */
  hmac(value: string, domain = 'idx'): string {
    return createHmac('sha256', this.cfg.HASH_PEPPER).update(domain).update('\0').update(value).digest('hex');
  }

  encrypt(plain: string): string {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.key, iv);
    const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
    return ['v1', iv.toString('base64url'), c.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.');
  }
  decrypt(blob: string): string {
    const [v, iv, tag, ct] = blob.split('.');
    if (v !== 'v1') throw new Error('unsupported ciphertext version');
    const d = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64url'));
    d.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8');
  }

  async hashSecret(secret: string): Promise<string> {
    const salt = randomBytes(16);
    const dk = await scrypt(secret, salt, 32, { N: 16384, r: 8, p: 1 });
    return `s1$${salt.toString('base64url')}$${dk.toString('base64url')}`;
  }
  async verifySecret(secret: string, stored: string): Promise<boolean> {
    const [v, salt, hash] = stored.split('$');
    if (v !== 's1') return false;
    const dk = await scrypt(secret, Buffer.from(salt, 'base64url'), 32, { N: 16384, r: 8, p: 1 });
    return safeEqual(dk.toString('base64url'), hash);
  }

  /** Short-lived HMAC signature for opaque URLs: base64url(HMAC(secret, payload)). */
  sign(payload: string): string {
    return createHmac('sha256', this.cfg.URL_SIGNING_SECRET).update(payload).digest('base64url');
  }
  verifySig(payload: string, sig: string): boolean {
    return safeEqual(this.sign(payload), sig);
  }
}
