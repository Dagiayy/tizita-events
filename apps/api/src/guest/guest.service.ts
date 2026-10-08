import { Inject, Injectable } from '@nestjs/common';
import { randomInt, randomUUID } from 'crypto';
import * as jwt from 'jsonwebtoken';
import { z } from 'zod';
import { AnalyticsService } from '../analytics/analytics.service';
import { AuditService } from '../audit/audit.service';
import { GuestClaims } from '../auth/auth.guard';
import { AppConfig, CONFIG } from '../common/config';
import { CryptoService, safeEqual, sha256Hex } from '../common/crypto';
import { AppError, E } from '../common/errors';
import { normalizeGuestPhone } from '../common/phone';
import { requestContext } from '../common/request-context';
import { Db } from '../infra/db.service';
import { RedisService } from '../infra/redis.service';
import { SettingsService } from '../infra/settings.service';
import { NotificationsService } from '../notifications/notifications.service';

export type Scope = 'upload' | 'gallery';
type LocatorKind = 'upload_token' | 'gallery_token' | 'join_code';
type Credential = 'none' | 'code' | 'passcode' | 'otp';

export const JoinSchema = z.object({
  code: z.string().trim().max(20).optional(),
  passcode: z.string().max(64).optional(),
  verification_proof: z.string().max(2000).optional(),
  display_name: z.string().trim().max(60).optional(),
  device_id: z.string().max(100).optional(),
  consent: z.object({ notice_version: z.string().max(60), accepted: z.literal(true) }).optional(),
}).strict();

@Injectable()
export class GuestService {
  constructor(
    private readonly db: Db,
    private readonly redis: RedisService,
    private readonly crypto: CryptoService,
    private readonly audit: AuditService,
    private readonly analytics: AnalyticsService,
    private readonly settings: SettingsService,
    private readonly sms: NotificationsService,
    @Inject(CONFIG) private readonly cfg: AppConfig,
  ) {}

  // ------------------------------------------------------------------ locator resolution
  /** Resolves an upload token, gallery token or short join code to its event. Unknown values look identical to "not found". */
  async resolve(locatorRaw: string): Promise<{ event: any; kind: LocatorKind }> {
    const v = (locatorRaw ?? '').trim();
    if (v.length < 6 || v.length > 80 || !/^[A-Za-z0-9_-]+$/.test(v)) throw E.notFound('event_not_found', 'This event link is not valid.');
    const kind: LocatorKind = v.startsWith('u_') && v.length > 20 ? 'upload_token' : v.startsWith('g_') && v.length > 20 ? 'gallery_token' : 'join_code';
    const value = kind === 'join_code' ? v.toUpperCase() : v;
    const row = await this.db.one<any>(
      `SELECT e.* FROM access_secrets s JOIN events e ON e.id = s.event_id
        WHERE s.token_hash = $1 AND s.secret_type = $2 AND s.revoked_at IS NULL`, [this.crypto.hmac(value, 'event-token'), kind]);
    if (!row || row.state === 'draft') throw E.notFound('event_not_found', 'This event link is not valid.');
    return { event: row, kind };
  }

  scopesOf(kind: LocatorKind, event: any): Scope[] {
    if (kind === 'upload_token') return ['upload'];
    if (kind === 'gallery_token') return ['gallery'];
    return event.join_code_scope === 'both' ? ['upload', 'gallery'] : [event.join_code_scope];
  }

  private modeOf(event: any, scope: Scope): string { return scope === 'upload' ? event.upload_access_mode : event.gallery_access_mode; }
  private credentialFor(mode: string): Credential {
    return mode === 'code' ? 'code' : mode === 'passcode' ? 'passcode' : mode === 'verified_phone' ? 'otp' : 'none';
  }

  private availability(event: any): 'open' | 'not_started' | 'closed' | 'unavailable' {
    if (['suspended', 'archived', 'deletion_pending', 'deleted', 'draft'].includes(event.state)) return 'unavailable';
    if (event.state === 'scheduled') return 'not_started';
    if (event.state === 'live') return 'open';
    return 'closed'; // closing / read_only: gallery only
  }

  async notice(event: any) {
    const doc = await this.db.one<any>(
      `SELECT version, title, body, locale, legal_status FROM policy_documents WHERE kind = 'guest_notice' AND locale = $1 ORDER BY effective_at DESC LIMIT 1`, [event.language]) ??
      await this.db.one<any>(`SELECT version, title, body, locale, legal_status FROM policy_documents WHERE kind = 'guest_notice' AND locale = 'en' ORDER BY effective_at DESC LIMIT 1`);
    return doc;
  }

  // ------------------------------------------------------------------ public event context
  async context(locator: string, ip: string | null, lang?: string, preview = false) {
    await this.redis.hit(`ctx:ip:${ip ?? 'x'}`, 240, 600);
    const { event, kind } = await this.resolve(locator);
    if (event.state === 'deleted') throw E.gone('event_deleted', 'This event is no longer available.');
    if (event.state === 'suspended') throw E.forbidden('event_unavailable', 'This event is currently unavailable.');
    if (!preview) this.analytics.inc(event.id, 'landing_view');   // server-side link-preview fetches are not guest visits
    const scopes = this.scopesOf(kind, event);
    const status = this.availability(event);
    const notice = await this.notice(event);
    const maxBytes = await this.settings.get<number>('media.max_bytes', this.cfg.MEDIA_MAX_BYTES);
    const allowed = await this.settings.get<string[]>('media.allowed_mime', this.cfg.MEDIA_ALLOWED_MIME.split(','));
    return {
      locator_kind: kind,
      status,
      event: {
        name: event.name, type: event.type, host_name: event.host_name, venue: event.venue, city: event.city,
        starts_at: event.starts_at, ends_at: event.ends_at, timezone: event.timezone, language: event.language, brand_color: event.brand_color,
        cover_url: event.cover_object_key ? this.coverUrl(event.public_code) : null,
      },
      scopes: scopes.map((s) => ({
        scope: s, mode: this.modeOf(event, s), credential: this.credentialFor(this.modeOf(event, s)),
        // join-code locators satisfy "code" mode by themselves
        credential_satisfied_by_locator: kind === 'join_code' && this.modeOf(event, s) === 'code',
      })),
      can_upload: scopes.includes('upload') && status === 'open' && event.uploads_enabled,
      guest_name_required: event.guest_name_required,
      captions_enabled: event.captions_enabled,
      downloads_enabled: event.downloads_enabled,
      slideshow_enabled: event.slideshow_enabled,
      show_uploader_names: event.show_uploader_names,
      notice: notice ? { version: notice.version, title: notice.title, body: notice.body, locale: notice.locale, legal_status: notice.legal_status } : null,
      limits: { max_bytes: maxBytes, allowed_mime: allowed, chunk_bytes: this.cfg.MEDIA_CHUNK_BYTES, caption_max: this.cfg.CAPTION_MAX_CHARS },
      lang: lang ?? event.language,
    };
  }

  coverUrl(publicCode: string): string {
    const exp = Math.floor(Date.now() / 1000) + this.cfg.SIGNED_URL_TTL_SEC;
    return `${this.cfg.PUBLIC_API_URL}/v1/c/${publicCode}?exp=${exp}&sig=${this.crypto.sign(`cover:${publicCode}:${exp}`)}`;
  }

  // ------------------------------------------------------------------ verified-phone step (optional, host-controlled)
  async verify(locator: string, body: { phone: string; code?: string }, ip: string | null) {
    const { event } = await this.resolve(locator);
    if (event.upload_access_mode !== 'verified_phone' && event.gallery_access_mode !== 'verified_phone') throw E.conflict('verification_not_required', 'This event does not use phone verification.');
    if (this.availability(event) === 'unavailable') throw E.forbidden('event_unavailable');
    const phone = normalizeGuestPhone(body.phone, this.cfg.GUEST_PHONE_ALLOW_FOREIGN);
    if (!phone) throw E.badRequest('invalid_phone', 'Enter a valid phone number.');
    const phoneHash = this.crypto.hmac(phone, 'phone');
    if (!body.code) {
      await this.redis.hit(`gv:req:phone:${phoneHash}`, this.cfg.RATE_LIMIT_OTP_PER_PHONE, 600);
      await this.redis.hit(`gv:req:ip:${ip ?? 'x'}`, this.cfg.RATE_LIMIT_OTP_PER_IP, 3600);
      await this.redis.hit(`gv:req:event:${event.id}`, 500, 86400); // SMS cost cap per event per day
      const code = this.cfg.OTP_FIXED_CODE || String(randomInt(0, 10 ** this.cfg.OTP_LENGTH)).padStart(this.cfg.OTP_LENGTH, '0');
      const id = randomUUID();
      await this.db.tx(async (c) => {
        await c.query(`UPDATE otp_challenges SET consumed_at = now() WHERE phone_hash = $1 AND purpose = 'guest_verify' AND event_id = $2 AND consumed_at IS NULL`, [phoneHash, event.id]);
        await c.query(
          `INSERT INTO otp_challenges (id, purpose, phone_hash, event_id, code_hash, expires_at, ip) VALUES ($1,'guest_verify',$2,$3,$4, now() + ($5 || ' seconds')::interval,$6)`,
          [id, phoneHash, event.id, this.crypto.hmac(`${id}:${code}`, 'otp'), String(this.cfg.OTP_TTL_SEC), ip]);
      });
      await this.sms.sendNow({ phone, template: 'otp_guest_verify', locale: event.language, params: { code, minutes: Math.round(this.cfg.OTP_TTL_SEC / 60) }, eventId: event.id });
      return { challenge_id: id, expires_in: this.cfg.OTP_TTL_SEC };
    }
    await this.redis.hit(`gv:verify:phone:${phoneHash}`, this.cfg.RATE_LIMIT_OTP_VERIFY_PER_PHONE, 900);
    await this.redis.hit(`gv:verify:ip:${ip ?? 'x'}`, this.cfg.RATE_LIMIT_OTP_VERIFY_PER_PHONE * 5, 900);
    const ch = await this.db.one<any>(
      `SELECT * FROM otp_challenges WHERE phone_hash = $1 AND purpose = 'guest_verify' AND event_id = $2 AND consumed_at IS NULL ORDER BY created_at DESC LIMIT 1`, [phoneHash, event.id]);
    if (!ch || new Date(ch.expires_at) < new Date()) throw E.unauthorized('otp_invalid', 'The code is invalid or expired.');
    if (ch.attempts >= this.cfg.OTP_MAX_ATTEMPTS) throw E.tooMany(900, 'otp_locked');
    if (!/^\d{4,8}$/.test(body.code) || !safeEqual(this.crypto.hmac(`${ch.id}:${body.code}`, 'otp'), ch.code_hash)) {
      await this.db.query('UPDATE otp_challenges SET attempts = attempts + 1 WHERE id = $1', [ch.id]);
      throw E.unauthorized('otp_invalid', 'The code is invalid or expired.');
    }
    const used = await this.db.query('UPDATE otp_challenges SET consumed_at = now() WHERE id = $1 AND consumed_at IS NULL', [ch.id]);
    if (used.rowCount === 0) throw E.unauthorized('otp_invalid', 'The code is invalid or expired.');
    const proof = jwt.sign({ typ: 'verify', eid: event.id, ph: phoneHash }, this.cfg.JWT_GUEST_SECRET, { algorithm: 'HS256', expiresIn: 600, issuer: 'event-platform' });
    return { verification_proof: proof, expires_in: 600 };
  }

  // ------------------------------------------------------------------ join (creates / upgrades a short-lived signed guest session)
  async join(locator: string, raw: unknown, ip: string | null, bearer?: string) {
    const body = JoinSchema.parse(raw ?? {});
    await this.redis.hit(`join:ip:${ip ?? 'x'}`, this.cfg.RATE_LIMIT_JOIN_PER_IP, 600);
    const { event, kind } = await this.resolve(locator);
    const status = this.availability(event);
    if (status === 'unavailable') throw E.forbidden('event_unavailable', 'This event is currently unavailable.');

    const ctx = requestContext();
    const deviceHash = body.device_id ? this.crypto.hmac(`${event.id}:${body.device_id}`, 'device') : this.crypto.hmac(`${ip ?? ''}|${ctx?.userAgent ?? ''}`, 'device-weak');
    const blocked = await this.db.one('SELECT 1 FROM blocked_devices WHERE event_id = $1 AND device_hash = $2', [event.id, deviceHash]);
    if (blocked) throw E.forbidden('session_blocked', 'You can no longer contribute to this event.');

    // existing session for this event (adds scopes instead of creating a second identity)
    let existing: any = null;
    if (bearer) {
      try {
        const c = jwt.verify(bearer, this.cfg.JWT_GUEST_SECRET, { algorithms: ['HS256'], issuer: 'event-platform' }) as GuestClaims;
        if (c.typ === 'guest' && c.eid === event.id) {
          existing = await this.db.one<any>('SELECT * FROM guest_sessions WHERE id = $1 AND event_id = $2', [c.sid, event.id]);
          if (existing?.blocked_at) throw E.forbidden('session_blocked', 'You can no longer contribute to this event.');
          if (existing && new Date(existing.expires_at) < new Date()) existing = null;
        }
      } catch (e) { if (e instanceof Error && (e as any).code === 'session_blocked') throw e; }
    }

    // verification proof (verified-phone mode)
    let proofPhoneHash: string | null = null;
    if (body.verification_proof) {
      try {
        const p = jwt.verify(body.verification_proof, this.cfg.JWT_GUEST_SECRET, { algorithms: ['HS256'], issuer: 'event-platform' }) as any;
        if (p.typ === 'verify' && p.eid === event.id) proofPhoneHash = p.ph;
      } catch { /* treated as absent */ }
    }

    const requested = this.scopesOf(kind, event);
    const granted: Scope[] = []; const required: Record<string, Credential> = {};
    let passcodeChecked: boolean | null = null;
    for (const scope of requested) {
      const mode = this.modeOf(event, scope);
      let ok = false;
      if (mode === 'open' || mode === 'view_only') ok = true;
      else if (mode === 'code') {
        ok = kind === 'join_code';
        if (!ok && body.code) ok = await this.joinCodeValid(event, body.code, scope);
      } else if (mode === 'passcode') {
        if (body.passcode) {
          if (passcodeChecked === null) passcodeChecked = await this.passcodeValid(event.id, body.passcode, ip);
          ok = passcodeChecked;
        }
      } else if (mode === 'verified_phone') ok = !!proofPhoneHash || !!existing?.phone_verified_at;
      if (ok) granted.push(scope); else required[scope] = this.credentialFor(mode);
    }
    if (!granted.length) throw new AppError(401, 'credential_required', 'Additional access credentials are required.', { required });

    if (granted.includes('upload')) {
      if (event.guest_name_required && !(body.display_name || existing?.display_name)) throw E.unprocessable('name_required', 'The host asks guests to enter a name.');
      if (!body.consent && !(existing && await this.hasConsent(existing.id))) throw E.unprocessable('consent_required', 'Please accept the event photo notice before uploading.');
    }

    const result = await this.db.tx(async (c) => {
      let sid: string; let scopes: Scope[]; let name: string | null;
      if (existing) {
        scopes = [...new Set([...(existing.scopes as Scope[]), ...granted])];
        name = body.display_name || existing.display_name || null;
        await c.query(
          `UPDATE guest_sessions SET scopes = $2, display_name = $3, phone_hash = COALESCE($4, phone_hash), phone_verified_at = CASE WHEN $4 IS NOT NULL THEN COALESCE(phone_verified_at, now()) ELSE phone_verified_at END WHERE id = $1`,
          [existing.id, scopes, name, proofPhoneHash]);
        sid = existing.id;
      } else {
        sid = randomUUID(); scopes = granted; name = body.display_name || null;
        await c.query(
          `INSERT INTO guest_sessions (id, event_id, token_hash, scopes, display_name, phone_hash, phone_verified_at, device_hash, ip_hash, user_agent, expires_at)
           VALUES ($1,$2,'pending',$3,$4,$5, CASE WHEN $5::text IS NOT NULL THEN now() END,$6,$7,$8, now() + ($9 || ' seconds')::interval)`,
          [sid, event.id, scopes, name, proofPhoneHash, deviceHash, this.crypto.hmac(ip ?? '', 'ip'), ctx?.userAgent ?? null, String(this.cfg.GUEST_SESSION_MAX_AGE_SEC)]);
      }
      if (body.consent) {
        const policy = await c.query(`SELECT version, locale FROM policy_documents WHERE kind = 'guest_notice' AND version = $1 LIMIT 1`, [body.consent.notice_version]);
        if (!policy.rows[0]) throw E.unprocessable('unknown_notice_version', 'The notice version is not recognised. Reload the page.');
        await c.query(
          `INSERT INTO consent_records (subject_type, guest_session_id, event_id, purpose, policy_kind, policy_version, locale, action, ip_hash)
           VALUES ('guest_session',$1,$2,'event_photo_upload','guest_notice',$3,$4,'granted',$5)`,
          [sid, event.id, body.consent.notice_version, policy.rows[0].locale, this.crypto.hmac(ip ?? '', 'ip')]);
      }
      return { sid, scopes, name, created: !existing };
    });

    const token = this.signToken(result.sid, event.id, result.scopes);
    await this.db.query('UPDATE guest_sessions SET token_hash = $2 WHERE id = $1', [result.sid, sha256Hex(token)]);
    this.analytics.inc(event.id, 'join');
    await this.analytics.step(result.sid, event.id, 'join');
    return { token, expires_in: this.cfg.GUEST_TOKEN_TTL_SEC, scopes: result.scopes, display_name: result.name, status };
  }

  private async hasConsent(sessionId: string): Promise<boolean> {
    return !!(await this.db.one(`SELECT 1 FROM consent_records WHERE guest_session_id = $1 AND purpose = 'event_photo_upload' AND action = 'granted' AND withdrawn_at IS NULL`, [sessionId]));
  }

  private async joinCodeValid(event: any, code: string, scope: Scope): Promise<boolean> {
    if (!(event.join_code_scope === 'both' || event.join_code_scope === scope)) return false;
    const row = await this.db.one('SELECT 1 FROM access_secrets WHERE event_id = $1 AND secret_type = \'join_code\' AND token_hash = $2 AND revoked_at IS NULL',
      [event.id, this.crypto.hmac(code.toUpperCase(), 'event-token')]);
    return !!row;
  }

  private async passcodeValid(eventId: string, passcode: string, ip: string | null): Promise<boolean> {
    await this.redis.hit(`pass:${eventId}:${ip ?? 'x'}`, 10, 600); // brute-force limiter per event + IP
    await this.redis.hit(`pass:${eventId}`, 200, 3600);
    const s = await this.db.one<{ token_hash: string }>(`SELECT token_hash FROM access_secrets WHERE event_id = $1 AND secret_type = 'passcode' AND revoked_at IS NULL`, [eventId]);
    return !!s && (await this.crypto.verifySecret(passcode, s.token_hash));
  }

  // ------------------------------------------------------------------ tokens / refresh
  signToken(sid: string, eid: string, scopes: Scope[]): string {
    const claims: GuestClaims = { sid, eid, scp: scopes, typ: 'guest' };
    return jwt.sign(claims, this.cfg.JWT_GUEST_SECRET, { algorithm: 'HS256', expiresIn: this.cfg.GUEST_TOKEN_TTL_SEC, issuer: 'event-platform' });
  }

  async refresh(sessionId: string, eventId: string) {
    const s = await this.db.one<any>('SELECT scopes, expires_at, blocked_at, display_name FROM guest_sessions WHERE id = $1 AND event_id = $2', [sessionId, eventId]);
    if (!s || s.blocked_at || new Date(s.expires_at) < new Date()) throw E.unauthorized('guest_session_expired', 'Your session expired. Please rejoin the event.');
    const token = this.signToken(sessionId, eventId, s.scopes);
    await this.db.query('UPDATE guest_sessions SET token_hash = $2 WHERE id = $1', [sessionId, sha256Hex(token)]);
    return { token, expires_in: this.cfg.GUEST_TOKEN_TTL_SEC, scopes: s.scopes, display_name: s.display_name };
  }

  async me(sessionId: string) {
    const s = await this.db.one<any>('SELECT id, scopes, display_name, phone_verified_at, upload_count, created_at, expires_at FROM guest_sessions WHERE id = $1', [sessionId]);
    const uploads = await this.db.many(
      `SELECT id, upload_state, moderation_state, created_at FROM media WHERE uploader_session_id = $1 AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 100`, [sessionId]);
    return { scopes: s.scopes, display_name: s.display_name, verified: !!s.phone_verified_at, upload_count: s.upload_count, expires_at: s.expires_at,
      uploads: uploads.map((u: any) => ({ id: u.id, state: u.upload_state === 'ready' ? u.moderation_state : u.upload_state, created_at: u.created_at })) };
  }
}
