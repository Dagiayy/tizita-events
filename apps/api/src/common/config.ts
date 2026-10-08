import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';

/** Loads the nearest .env upward from cwd (no dependency; values already in process.env win). */
function loadDotEnv(): void {
  let dir = process.cwd();
  for (let i = 0; i < 4; i++) {
    const file = path.join(dir, '.env');
    if (fs.existsSync(file)) {
      for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;
        const eq = line.indexOf('=');
        if (eq < 1) continue;
        const key = line.slice(0, eq).trim();
        let val = line.slice(eq + 1).trim();
        if (!/^["']/.test(val)) val = val.replace(/\s+#.*$/, '');
        val = val.replace(/^["']|["']$/g, '');
        if (process.env[key] === undefined) process.env[key] = val;
      }
      return;
    }
    dir = path.dirname(dir);
  }
}

const bool = z.preprocess((v) => (typeof v === 'string' ? ['true', '1', 'yes'].includes(v.toLowerCase()) : v), z.boolean());
const int = (def: number) => z.coerce.number().int().default(def);
const str = (def = '') => z.string().default(def);

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  APP_ROLE: z.enum(['api', 'worker', 'all']).default('all'),
  PORT: int(4000),
  PUBLIC_WEB_URL: str('http://localhost:3000'),
  PUBLIC_API_URL: str('http://localhost:4000'),
  CORS_ORIGINS: str('http://localhost:3000'),
  TRUST_PROXY: bool.default(false),
  DATA_RESIDENCY_ALLOWED_HOST_SUFFIXES: str('localhost,127.0.0.1,.internal,.et'),

  DATABASE_URL: str('postgres://event:event_dev_password@localhost:5433/event'),
  DATABASE_POOL_MAX: int(20),
  DATABASE_SSL: bool.default(false),
  REDIS_URL: str('redis://localhost:6380/0'),

  S3_ENDPOINT: str('http://localhost:9100'),
  S3_REGION: str('et-addis-1'),
  S3_ACCESS_KEY: str('minio_dev_access'),
  S3_SECRET_KEY: str('minio_dev_secret_change_me'),
  S3_FORCE_PATH_STYLE: bool.default(true),
  S3_BUCKET_QUARANTINE: str('event-quarantine'),
  S3_BUCKET_MEDIA: str('event-media'),
  S3_BUCKET_EXPORTS: str('event-exports'),
  S3_SSE: bool.default(false),

  JWT_ACCESS_SECRET: str('dev_only_access_secret_change_me_0123456789abcdef'),
  JWT_GUEST_SECRET: str('dev_only_guest_secret_change_me_0123456789abcdef'),
  URL_SIGNING_SECRET: str('dev_only_url_signing_secret_change_me_0123456789'),
  HASH_PEPPER: str('dev_only_hash_pepper_change_me_0123456789abcdef'),
  DATA_ENCRYPTION_KEY: str('MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY='),

  ACCESS_TOKEN_TTL_SEC: int(900),
  REFRESH_TOKEN_TTL_SEC: int(2592000),
  GUEST_TOKEN_TTL_SEC: int(43200),
  GUEST_SESSION_MAX_AGE_SEC: int(604800),
  SIGNED_URL_TTL_SEC: int(1800),
  UPLOAD_TOKEN_TTL_SEC: int(3600),
  EXPORT_LINK_TTL_SEC: int(900),

  OTP_TTL_SEC: int(300),
  OTP_LENGTH: int(6),
  OTP_MAX_ATTEMPTS: int(5),
  OTP_FIXED_CODE: str(''),
  /** Staff must complete authenticator-app 2FA. May only be switched off outside production. */
  ADMIN_MFA_REQUIRED: bool.default(true),
  SMS_PROVIDERS: str('console'),
  SMS_HTTP_PRIMARY_URL: str(''),
  SMS_HTTP_PRIMARY_API_KEY: str(''),
  SMS_HTTP_PRIMARY_SENDER_ID: str(''),
  SMS_HTTP_FALLBACK_URL: str(''),
  SMS_HTTP_FALLBACK_API_KEY: str(''),
  SMS_HTTP_FALLBACK_SENDER_ID: str(''),
  GUEST_PHONE_ALLOW_FOREIGN: bool.default(false),

  PAYMENT_PROVIDER: z.enum(['sandbox', 'chapa', 'telebirr']).default('sandbox'),
  PAYMENT_CALLBACK_BASE_URL: str('http://localhost:4000'),
  CHAPA_SECRET_KEY: str(''),
  CHAPA_WEBHOOK_SECRET: str(''),
  CHAPA_BASE_URL: str('https://api.chapa.co/v1'),
  SANDBOX_PAYMENT_SECRET: str('dev_only_sandbox_payment_secret'),
  TELEBIRR_APP_ID: str(''),
  TELEBIRR_APP_KEY: str(''),
  TELEBIRR_BASE_URL: str(''),

  AV_MODE: z.enum(['clamd', 'eicar']).default('eicar'),
  CLAMD_HOST: str('localhost'),
  CLAMD_PORT: int(3310),

  MEDIA_MAX_BYTES: int(15 * 1024 * 1024),
  MEDIA_ALLOWED_MIME: str('image/jpeg,image/png,image/webp,image/heic,image/heif'),
  MEDIA_MAX_PIXELS: int(60_000_000),
  MEDIA_CHUNK_BYTES: int(1024 * 1024),
  DERIV_THUMB_PX: int(480),
  DERIV_GALLERY_PX: int(1280),
  DERIV_VIEWER_PX: int(2560),
  DERIV_JPEG_QUALITY: int(85),
  CAPTION_MAX_CHARS: int(300),

  RATE_LIMIT_OTP_PER_PHONE: int(3),
  RATE_LIMIT_OTP_PER_IP: int(20),
  RATE_LIMIT_OTP_VERIFY_PER_PHONE: int(10),
  RATE_LIMIT_JOIN_PER_IP: int(60),
  RATE_LIMIT_UPLOAD_INTENT_PER_SESSION: int(30),
  RATE_LIMIT_REPORT_PER_SESSION: int(10),
  GUEST_MAX_UPLOADS_PER_SESSION: int(100),

  RETENTION_DEFAULT_DAYS: int(180),
  READONLY_TO_ARCHIVE_DAYS: int(30),
  DELETION_GRACE_DAYS: int(14),
  CLOSING_MAX_MINUTES: int(30),
  BACKUP_RETENTION_DAYS: int(35),
  LIFECYCLE_TICK_SEC: int(30),

  FEATURE_COMMENTS: bool.default(false),
  FEATURE_REACTIONS: bool.default(false),
  FEATURE_VIDEO: bool.default(false),
  FEATURE_GEO_RESTRICTION: bool.default(false),

  METRICS_TOKEN: str('dev_only_metrics_token'),
  LOG_LEVEL: str('info'),
});

export type AppConfig = z.infer<typeof schema> & { isProd: boolean; isTest: boolean };

const DEV_MARKER = /dev_only|change_me/;

/** Boot-time safety checks: refuse to run production with dev secrets or non-Ethiopian dependencies. */
export function assertProductionSafety(c: AppConfig): void {
  if (!c.isProd) return;
  const problems: string[] = [];
  for (const k of ['JWT_ACCESS_SECRET', 'JWT_GUEST_SECRET', 'URL_SIGNING_SECRET', 'HASH_PEPPER', 'METRICS_TOKEN', 'S3_SECRET_KEY'] as const) {
    if (DEV_MARKER.test(c[k]) || c[k].length < 32) problems.push(`${k} must be a unique secret of >= 32 chars`);
  }
  if (c.DATA_ENCRYPTION_KEY === 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=') problems.push('DATA_ENCRYPTION_KEY is the development key');
  if (c.OTP_FIXED_CODE) problems.push('OTP_FIXED_CODE must be empty');
  if (!c.ADMIN_MFA_REQUIRED) problems.push('ADMIN_MFA_REQUIRED must be true');
  if (c.AV_MODE !== 'clamd') problems.push('AV_MODE must be clamd');
  if (c.PAYMENT_PROVIDER === 'sandbox') problems.push('PAYMENT_PROVIDER=sandbox is not allowed');
  if (/^(console|memory)$/.test(c.SMS_PROVIDERS.split(',')[0].trim())) problems.push('SMS_PROVIDERS must start with a real provider');
  if (!c.PUBLIC_API_URL.startsWith('https://') || !c.PUBLIC_WEB_URL.startsWith('https://')) problems.push('PUBLIC_*_URL must be https');
  const allowed = c.DATA_RESIDENCY_ALLOWED_HOST_SUFFIXES.split(',').map((s) => s.trim()).filter(Boolean);
  for (const [name, url] of [['DATABASE_URL', c.DATABASE_URL], ['REDIS_URL', c.REDIS_URL], ['S3_ENDPOINT', c.S3_ENDPOINT]] as const) {
    let host = '';
    try { host = new URL(url).hostname; } catch { problems.push(`${name} is not a valid URL`); continue; }
    if (/amazonaws\.com$|\.googleapis\.com$|\.azure\.com$|cloudflarestorage\.com$/.test(host)) problems.push(`${name} points to a foreign cloud (${host}); data must stay in Ethiopia`);
    else if (!allowed.some((s) => host === s || (s.startsWith('.') && host.endsWith(s)))) problems.push(`${name} host ${host} is not in DATA_RESIDENCY_ALLOWED_HOST_SUFFIXES`);
  }
  if (problems.length) throw new Error('Unsafe production configuration:\n - ' + problems.join('\n - '));
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  if (env === process.env) loadDotEnv();
  const parsed = schema.parse(env);
  const cfg: AppConfig = { ...parsed, isProd: parsed.NODE_ENV === 'production', isTest: parsed.NODE_ENV === 'test' };
  assertProductionSafety(cfg);
  return cfg;
}

export const CONFIG = Symbol('CONFIG');
