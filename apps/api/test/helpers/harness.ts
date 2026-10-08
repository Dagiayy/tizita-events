import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { Client } from 'pg';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/bootstrap';
import { AppConfig, CONFIG } from '../../src/common/config';
import { CryptoService, base32Decode, totpAt } from '../../src/common/crypto';
import { normalizeEthiopianPhone } from '../../src/common/phone';
import { Db } from '../../src/infra/db.service';
import { StorageService } from '../../src/infra/storage.service';
import { runMigrations } from '../../src/infra/migrate';
import { MemorySmsProvider } from '../../src/notifications/notifications.service';
import { ProcessingService } from '../../src/media/processing.service';
import { RedisService } from '../../src/infra/redis.service';
import { makeJpeg } from './images';

const KEEP = ['plans', 'system_settings', 'policy_documents', 'vendors', 'schema_migrations'];

export interface Harness {
  app: INestApplication; http: () => request.Agent; cfg: AppConfig; db: Db; crypto: CryptoService; storage: StorageService; redis: RedisService;
  get: <T>(cls: any) => T; close: () => Promise<void>;
}

export async function bootHarness(): Promise<Harness> {
  const url = new URL(process.env.DATABASE_URL!);
  const dbName = url.pathname.slice(1);
  const adminUrl = new URL(url.toString()); adminUrl.pathname = '/postgres';
  const admin = new Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  if (!(await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName])).rowCount) await admin.query(`CREATE DATABASE ${dbName}`);
  await admin.end();
  await runMigrations(process.env.DATABASE_URL!, undefined, () => undefined);
  const cleaner = new Client({ connectionString: process.env.DATABASE_URL });
  await cleaner.connect();
  const tables = (await cleaner.query(`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`)).rows.map((r) => r.tablename).filter((t) => !KEEP.includes(t));
  await cleaner.query(`TRUNCATE ${tables.map((t) => `"${t}"`).join(', ')} RESTART IDENTITY CASCADE`);
  await cleaner.query(`UPDATE system_settings SET value = 'false'::jsonb WHERE key = 'maintenance.mode'`);
  // reference data must not leak between runs (earlier tests edit prices/settings)
  await cleaner.query(`UPDATE plans SET price_etb = v.p FROM (VALUES ('trial',0),('single_event',1200),('event_plus',2800),('professional',6500),('addon_storage_10gb',400),('addon_retention_90d',300)) AS v(c,p) WHERE plans.code = v.c`);
  await cleaner.query(`UPDATE system_settings SET value = '30'::jsonb WHERE key = 'rights.sla_days'`);
  await cleaner.end();

  const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = mod.createNestApplication({ bodyParser: false });
  const cfg = app.get<AppConfig>(CONFIG);
  configureApp(app, cfg);
  await app.init();
  const storage = app.get(StorageService);
  await storage.ensureBuckets();
  for (const b of ['quarantine', 'media', 'exports'] as const) await storage.deletePrefix(b, '');
  const redis = app.get(RedisService);
  await redis.client.flushdb();
  MemorySmsProvider.outbox = [];
  return {
    app, cfg, db: app.get(Db), crypto: app.get(CryptoService), storage, redis,
    http: () => request.agent(app.getHttpServer()) as any, get: (c) => app.get(c), close: async () => { await app.close(); },
  };
}

let phoneCounter = 0;
export const nextPhone = (): string => `+2519${String(10000000 + ++phoneCounter + Math.floor(Math.random() * 80000000)).slice(0, 8)}`.slice(0, 13);

export class Client_ {
  token = ''; refresh = ''; userId = ''; sessionId = ''; phone = '';
  constructor(readonly h: Harness) {}
  static async host(h: Harness, phone = nextPhone(), device = 'jest'): Promise<Client_> {
    const c = new Client_(h); c.phone = phone;
    await h.http().post('/v1/auth/request-otp').send({ phone, locale: 'en' }).expect(200);
    const code = MemorySmsProvider.lastCode(normalizeEthiopianPhone(phone)!)!;
    const res = await h.http().post('/v1/auth/verify-otp').send({ phone, code, device_label: device }).expect(200);
    c.token = res.body.access_token; c.refresh = res.body.refresh_token; c.userId = res.body.user.id; c.sessionId = res.body.session_id;
    return c;
  }
  req(method: 'get' | 'post' | 'put' | 'patch' | 'delete', url: string) {
    const r = (this.h.http() as any)[method](url);
    r.set('User-Agent', 'jest-agent/1.0');
    return this.token ? r.set('Authorization', `Bearer ${this.token}`) : r;
  }
  get = (u: string) => this.req('get', u);
  post = (u: string, b: unknown = {}) => this.req('post', u).send(b as any);
  patch = (u: string, b: unknown = {}) => this.req('patch', u).send(b as any);
  put = (u: string, b: unknown = {}) => this.req('put', u).send(b as any);
  del = (u: string) => this.req('delete', u);
}

/** Staff user with MFA enrolled. totp() always yields a code that has not been used yet (resets replay counter in the DB). */
export class Staff extends Client_ {
  secret = '';
  static async create(h: Harness, role: 'super_admin' | 'support_agent' = 'super_admin'): Promise<Staff> {
    const phone = nextPhone(); const e164 = normalizeEthiopianPhone(phone)!;
    await h.db.query(`INSERT INTO users (phone_hash, phone_enc, phone_last4, platform_role) VALUES ($1,$2,$3,$4)`, [h.crypto.hmac(e164, 'phone'), h.crypto.encrypt(e164), e164.slice(-4), role]);
    const c = (await Client_.host(h, phone, 'staff')) as Staff;
    Object.setPrototypeOf(c, Staff.prototype);
    const enr = await c.post('/v1/auth/2fa/enroll').expect(200);
    c.secret = enr.body.secret;
    const v = await c.post('/v1/auth/2fa/verify', { code: await c.totp() }).expect(200);
    c.token = v.body.access_token;
    return c;
  }
  async totp(): Promise<string> {
    await this.h.db.query('UPDATE users SET totp_last_step = NULL WHERE id = $1', [this.userId]);
    return totpAt(this.secret, Math.floor(Date.now() / 30000));
  }
}

export interface EventFixture { id: string; code: string; uploadToken: string; galleryToken: string; joinCode: string }

/** Creates an event for `host`, activates it with the free trial (or a sandbox-paid plan) and returns share secrets. */
export async function createEvent(h: Harness, host: Client_, over: Record<string, unknown> = {}, activate: 'trial' | 'none' = 'trial'): Promise<EventFixture> {
  const now = Date.now();
  const res = await host.post('/v1/events', {
    name: 'ሠርግ - Abebe & Sara Wedding', type: 'wedding', city: 'Addis Ababa', venue: 'Skylight Hotel', host_name: 'Abebe', language: 'en',
    starts_at: new Date(now - 3600_000).toISOString(), ends_at: new Date(now + 6 * 3600_000).toISOString(),
    upload_opens_at: new Date(now - 3600_000).toISOString(), upload_closes_at: new Date(now + 24 * 3600_000).toISOString(), ...over,
  });
  if (res.status !== 201 && res.status !== 200) throw new Error(`create event failed ${res.status} ${JSON.stringify(res.body)}`);
  const id = res.body.id;
  if (activate === 'trial') await host.post(`/v1/events/${id}/activate-trial`).expect(200);
  const links = activate === 'trial' ? (await host.get(`/v1/events/${id}/share-links`).expect(200)).body : null;
  return { id, code: res.body.public_code, uploadToken: links ? links.upload_url.split('/j/')[1].split('?')[0] : '', galleryToken: links ? links.gallery_url.split('/j/')[1].split('?')[0] : '', joinCode: links?.join_code ?? '' };
}

export async function joinAsGuest(h: Harness, locator: string, body: Record<string, unknown> = {}, bearer?: string) {
  const r = h.http().post(`/v1/events/${locator}/join`);
  if (bearer) r.set('Authorization', `Bearer ${bearer}`);
  return r.send({ consent: { notice_version: '2026-10-draft', accepted: true }, ...body });
}

export async function guestUpload(h: Harness, guest: { token: string }, buf: Buffer, opts: { mime?: string; process?: boolean; chunkFail?: number } = {}) {
  const intent = await h.http().post('/v1/guest/uploads/intents').set('Authorization', `Bearer ${guest.token}`).send({ mime: opts.mime ?? 'image/jpeg', size: buf.length });
  if (intent.status !== 200) return { intent, mediaId: null as string | null };
  const { media_id, upload } = intent.body;
  await sendChunks(h, upload, buf);
  const done = await h.http().post(`/v1/media/${media_id}/complete`).set('X-Upload-Token', upload.token).send();
  if (opts.process !== false && done.status === 200) await h.get<ProcessingService>(ProcessingService).process(media_id);
  return { intent, mediaId: media_id as string, done, upload };
}

export async function sendChunks(h: Harness, upload: any, buf: Buffer) {
  for (let i = 0; i < upload.total_chunks; i++) {
    const part = buf.subarray(i * upload.chunk_bytes, Math.min((i + 1) * upload.chunk_bytes, buf.length));
    await h.http().put(`/v1/uploads/${upload.url.split('/').pop()}/chunks/${i}`).set('X-Upload-Token', upload.token).set('Content-Type', 'application/octet-stream').send(part).expect(200);
  }
}

export const photo = (seed: number, extra: Parameters<typeof makeJpeg>[0] = {}) => makeJpeg({ seed, width: 1200, height: 800, ...extra });
export { base32Decode };

/** supertest parser that returns the raw response bytes (images, PDFs, ZIPs). */
export const binaryParser = (res: any, cb: (err: Error | null, body: Buffer) => void) => {
  const chunks: Buffer[] = [];
  res.on('data', (d: Buffer) => chunks.push(d));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
};
