import { Inject, Injectable } from '@nestjs/common';
import { randomInt, randomUUID } from 'crypto';
import * as jwt from 'jsonwebtoken';
import { AuditService } from '../audit/audit.service';
import { AppConfig, CONFIG } from '../common/config';
import { CryptoService, base32Encode, randomToken, safeEqual, sha256Hex, totpVerify } from '../common/crypto';
import { E } from '../common/errors';
import { normalizeEthiopianPhone } from '../common/phone';
import { requestContext } from '../common/request-context';
import { Db } from '../infra/db.service';
import { RedisService } from '../infra/redis.service';
import { NotificationsService } from '../notifications/notifications.service';
import { randomBytes } from 'crypto';

export interface AccessClaims { sub: string; sid: string; role: 'none' | 'super_admin' | 'support_agent'; mfa: boolean; typ: 'access' }
export interface TokenPair { access_token: string; access_expires_in: number; refresh_token: string; session_id: string }

@Injectable()
export class AuthService {
  constructor(
    @Inject(CONFIG) private readonly cfg: AppConfig,
    private readonly db: Db,
    private readonly redis: RedisService,
    private readonly crypto: CryptoService,
    private readonly sms: NotificationsService,
    private readonly audit: AuditService,
  ) {}

  // ------------------------------------------------------------------ OTP
  /**
   * Always answers the same way whether or not the number is registered (no account enumeration).
   * Limits: per phone and per IP; challenge codes are stored only as keyed hashes.
   */
  async requestOtp(phoneInput: string, locale: 'en' | 'am', ip: string | null): Promise<{ challenge_id: string; expires_in: number }> {
    const phone = normalizeEthiopianPhone(phoneInput);
    if (!phone) throw E.badRequest('invalid_phone', 'Enter a valid Ethiopian mobile number (+251 9XX XXX XXX or +251 7XX XXX XXX).');
    const phoneHash = this.crypto.hmac(phone, 'phone');
    await this.redis.hit(`otp:req:phone:${phoneHash}`, this.cfg.RATE_LIMIT_OTP_PER_PHONE, 600);
    await this.redis.hit(`otp:req:ip:${ip ?? 'unknown'}`, this.cfg.RATE_LIMIT_OTP_PER_IP, 3600);

    const code = this.cfg.OTP_FIXED_CODE || String(randomInt(0, 10 ** this.cfg.OTP_LENGTH)).padStart(this.cfg.OTP_LENGTH, '0');
    const id = randomUUID();
    await this.db.tx(async (c) => {
      await c.query(`UPDATE otp_challenges SET consumed_at = now() WHERE phone_hash = $1 AND purpose = 'host_login' AND consumed_at IS NULL`, [phoneHash]);
      await c.query(
        `INSERT INTO otp_challenges (id, purpose, phone_hash, code_hash, expires_at, ip) VALUES ($1,'host_login',$2,$3, now() + ($4 || ' seconds')::interval, $5)`,
        [id, phoneHash, this.codeHash(id, code), String(this.cfg.OTP_TTL_SEC), ip]);
    });
    await this.sms.sendNow({ phone, template: 'otp_host_login', locale, params: { code, minutes: Math.round(this.cfg.OTP_TTL_SEC / 60) } });
    return { challenge_id: id, expires_in: this.cfg.OTP_TTL_SEC };
  }

  private codeHash(challengeId: string, code: string): string { return this.crypto.hmac(`${challengeId}:${code}`, 'otp'); }

  async verifyOtp(input: { phone: string; code: string; deviceLabel?: string; recovery?: boolean; webCookie?: boolean }, ip: string | null, ua: string | null) {
    const phone = normalizeEthiopianPhone(input.phone);
    if (!phone || !/^\d{4,8}$/.test(input.code)) throw E.badRequest('invalid_credentials_format', 'Invalid phone or code.');
    const phoneHash = this.crypto.hmac(phone, 'phone');
    // Brute-force protection: attempts are limited per phone and per IP independent of challenge state.
    await this.redis.hit(`otp:verify:phone:${phoneHash}`, this.cfg.RATE_LIMIT_OTP_VERIFY_PER_PHONE, 900);
    await this.redis.hit(`otp:verify:ip:${ip ?? 'unknown'}`, this.cfg.RATE_LIMIT_OTP_VERIFY_PER_PHONE * 5, 900);

    const ch = await this.db.one<any>(
      `SELECT * FROM otp_challenges WHERE phone_hash = $1 AND purpose = 'host_login' AND consumed_at IS NULL ORDER BY created_at DESC LIMIT 1`, [phoneHash]);
    if (!ch || new Date(ch.expires_at) < new Date()) throw E.unauthorized('otp_invalid', 'The code is invalid or expired. Request a new one.');
    if (ch.attempts >= this.cfg.OTP_MAX_ATTEMPTS) {
      await this.db.query('UPDATE otp_challenges SET consumed_at = now() WHERE id = $1', [ch.id]);
      throw E.tooMany(900, 'otp_locked');
    }
    if (!safeEqual(this.codeHash(ch.id, input.code), ch.code_hash)) {
      await this.db.query('UPDATE otp_challenges SET attempts = attempts + 1 WHERE id = $1', [ch.id]);
      throw E.unauthorized('otp_invalid', 'The code is invalid or expired. Request a new one.');
    }
    // Single-use: consume atomically so parallel requests cannot both succeed.
    const consumed = await this.db.query('UPDATE otp_challenges SET consumed_at = now() WHERE id = $1 AND consumed_at IS NULL', [ch.id]);
    if (consumed.rowCount === 0) throw E.unauthorized('otp_invalid', 'The code is invalid or expired. Request a new one.');

    const { user, created } = await this.findOrCreateUser(phone, phoneHash);
    if (user.status !== 'active') throw E.forbidden('account_suspended', 'This account is not active. Contact support.');
    const session = await this.createSession(user.id, user.platform_role !== 'none' ? false : true, input.deviceLabel, ip, ua);
    if (input.recovery) {
      await this.db.query(`UPDATE sessions SET revoked_at = now(), revoke_reason = 'recovery' WHERE user_id = $1 AND id <> $2 AND revoked_at IS NULL`, [user.id, session.sessionId]);
    }
    await this.db.query('UPDATE users SET last_login_at = now() WHERE id = $1', [user.id]);
    await this.audit.record({
      action: created ? 'auth.signup' : input.recovery ? 'auth.recovery' : 'auth.login', resourceType: 'user', resourceId: user.id,
      actor: { type: user.platform_role !== 'none' ? 'staff' : 'user', id: user.id, role: user.platform_role !== 'none' ? user.platform_role : null },
      after: { session_id: session.sessionId },
    });
    const isStaff = user.platform_role !== 'none';
    return {
      ...session.pair,
      is_new_user: created,
      user: { id: user.id, display_name: user.display_name, locale: user.locale, platform_role: user.platform_role, phone_last4: user.phone_last4 },
      mfa_required: isStaff && this.cfg.ADMIN_MFA_REQUIRED,
      mfa_enrolled: isStaff ? !!user.totp_enabled : undefined,
    };
  }

  private async findOrCreateUser(phone: string, phoneHash: string): Promise<{ user: any; created: boolean }> {
    const existing = await this.db.one<any>('SELECT * FROM users WHERE phone_hash = $1', [phoneHash]);
    if (existing) return { user: existing, created: false };
    const user = await this.db.tx(async (c) => {
      const ins = await c.query(
        `INSERT INTO users (phone_hash, phone_enc, phone_last4) VALUES ($1,$2,$3) ON CONFLICT (phone_hash) DO NOTHING RETURNING *`,
        [phoneHash, this.crypto.encrypt(phone), phone.slice(-4)]);
      if (!ins.rows[0]) return null;
      return ins.rows[0];
    });
    if (!user) return { user: await this.db.one<any>('SELECT * FROM users WHERE phone_hash = $1', [phoneHash]), created: false };
    // Accept pending collaborator invitations addressed to this phone number.
    await this.db.query(
      `UPDATE event_members SET user_id = $1, status = 'active', invite_phone_hash = NULL WHERE invite_phone_hash = $2 AND status = 'invited'`, [user.id, phoneHash]);
    return { user, created: true };
  }

  /** Invitations to an already-registered number activate on next login too. */
  private async acceptInvites(userId: string, phoneHash: string): Promise<void> {
    await this.db.query(
      `UPDATE event_members SET user_id = $1, status = 'active', invite_phone_hash = NULL WHERE invite_phone_hash = $2 AND status = 'invited'`, [userId, phoneHash]);
  }

  // ------------------------------------------------------------------ sessions & tokens
  private async createSession(userId: string, mfa: boolean, deviceLabel: string | undefined, ip: string | null, ua: string | null) {
    const refresh = randomToken(48);
    const row = await this.db.one<{ id: string }>(
      `INSERT INTO sessions (user_id, refresh_hash, device_label, user_agent, ip, mfa_verified, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6, now() + ($7 || ' seconds')::interval) RETURNING id`,
      [userId, sha256Hex(refresh), (deviceLabel ?? '').slice(0, 80) || null, (ua ?? '').slice(0, 300) || null, ip, mfa, String(this.cfg.REFRESH_TOKEN_TTL_SEC)]);
    const u = await this.db.one<{ platform_role: AccessClaims['role']; phone_hash: string }>('SELECT platform_role, phone_hash FROM users WHERE id = $1', [userId]);
    await this.acceptInvites(userId, u!.phone_hash);
    return { sessionId: row!.id, pair: this.issue(userId, row!.id, u!.platform_role, mfa, refresh) };
  }

  issue(userId: string, sessionId: string, role: AccessClaims['role'], mfa: boolean, refresh: string): TokenPair {
    return { access_token: this.signAccess(userId, sessionId, role, mfa), access_expires_in: this.cfg.ACCESS_TOKEN_TTL_SEC, refresh_token: refresh, session_id: sessionId };
  }
  signAccess(userId: string, sessionId: string, role: AccessClaims['role'], mfa: boolean): string {
    const claims: AccessClaims = { sub: userId, sid: sessionId, role, mfa, typ: 'access' };
    return jwt.sign(claims, this.cfg.JWT_ACCESS_SECRET, { algorithm: 'HS256', expiresIn: this.cfg.ACCESS_TOKEN_TTL_SEC, issuer: 'event-platform' });
  }
  verifyAccess(token: string): AccessClaims {
    try {
      const c = jwt.verify(token, this.cfg.JWT_ACCESS_SECRET, { algorithms: ['HS256'], issuer: 'event-platform' }) as AccessClaims;
      if (c.typ !== 'access') throw new Error('typ');
      return c;
    } catch { throw E.unauthorized('invalid_token', 'Invalid or expired token'); }
  }

  /** Rotating refresh tokens with reuse detection: a replayed old token revokes the session. */
  async refresh(refreshToken: string, ip: string | null) {
    const h = sha256Hex(refreshToken);
    const s = await this.db.one<any>(`SELECT s.*, u.platform_role, u.status AS user_status FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.refresh_hash = $1`, [h]);
    if (!s) {
      const reused = await this.db.one<any>('SELECT id, user_id FROM sessions WHERE prev_refresh_hash = $1 AND revoked_at IS NULL', [h]);
      if (reused) {
        await this.db.query(`UPDATE sessions SET revoked_at = now(), revoke_reason = 'refresh_reuse_detected' WHERE id = $1`, [reused.id]);
        await this.audit.record({ action: 'auth.refresh_reuse_detected', resourceType: 'session', resourceId: reused.id, actor: { type: 'system' }, after: { user_id: reused.user_id } });
      }
      throw E.unauthorized('invalid_refresh', 'Session expired. Please sign in again.');
    }
    if (s.revoked_at || new Date(s.expires_at) < new Date() || s.user_status !== 'active') throw E.unauthorized('invalid_refresh', 'Session expired. Please sign in again.');
    const next = randomToken(48);
    const upd = await this.db.query(
      `UPDATE sessions SET refresh_hash = $2, prev_refresh_hash = $3, last_used_at = now(), ip = COALESCE($4, ip),
              expires_at = now() + ($5 || ' seconds')::interval
        WHERE id = $1 AND refresh_hash = $3 AND revoked_at IS NULL`,
      [s.id, sha256Hex(next), h, ip, String(this.cfg.REFRESH_TOKEN_TTL_SEC)]);
    if (upd.rowCount === 0) throw E.unauthorized('invalid_refresh', 'Session expired. Please sign in again.');
    return this.issue(s.user_id, s.id, s.platform_role, s.mfa_verified, next);
  }

  async listSessions(userId: string, currentSid: string) {
    const rows = await this.db.many(
      `SELECT id, device_label, user_agent, host(ip) AS ip, created_at, last_used_at, mfa_verified FROM sessions
        WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now() ORDER BY last_used_at DESC`, [userId]);
    return rows.map((r: any) => ({ ...r, current: r.id === currentSid }));
  }

  async revokeSession(userId: string, sessionId: string, reason = 'user_revoked'): Promise<void> {
    const r = await this.db.query(`UPDATE sessions SET revoked_at = now(), revoke_reason = $3 WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL`, [sessionId, userId, reason]);
    if (r.rowCount === 0) throw E.notFound('session_not_found');
    await this.audit.record({ action: 'auth.session_revoked', resourceType: 'session', resourceId: sessionId, after: { reason } });
  }
  async revokeAll(userId: string, exceptSid?: string): Promise<number> {
    const r = await this.db.query(
      `UPDATE sessions SET revoked_at = now(), revoke_reason = 'revoke_all' WHERE user_id = $1 AND revoked_at IS NULL AND ($2::uuid IS NULL OR id <> $2)`, [userId, exceptSid ?? null]);
    await this.audit.record({ action: 'auth.sessions_revoked_all', resourceType: 'user', resourceId: userId, after: { count: r.rowCount } });
    return r.rowCount ?? 0;
  }

  async isSessionActive(sessionId: string, userId: string): Promise<{ active: boolean; mfa: boolean; role: AccessClaims['role'] }> {
    const s = await this.db.one<any>(
      `SELECT s.revoked_at, s.expires_at, s.mfa_verified, u.status, u.platform_role FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = $1 AND s.user_id = $2`, [sessionId, userId]);
    const active = !!s && !s.revoked_at && new Date(s.expires_at) > new Date() && s.status === 'active';
    return { active, mfa: !!s?.mfa_verified, role: s?.platform_role ?? 'none' };
  }

  // ------------------------------------------------------------------ staff 2FA (spec 15.3 / 18)
  async enrollTotp(userId: string) {
    const u = await this.db.one<any>('SELECT * FROM users WHERE id = $1', [userId]);
    if (!u || u.platform_role === 'none') throw E.forbidden('not_staff');
    if (u.totp_enabled) throw E.conflict('totp_already_enrolled', '2FA is already enabled. Ask a super admin to reset it.');
    const secret = base32Encode(randomBytes(20));
    await this.db.query('UPDATE users SET totp_secret_enc = $2 WHERE id = $1', [userId, this.crypto.encrypt(secret)]);
    return { secret, otpauth_uri: `otpauth://totp/EventPlatform:${u.phone_last4}?secret=${secret}&issuer=EventPlatform&digits=6&period=30` };
  }

  /** Verifies a TOTP code. Each 30 s step can be used once (replay protection). Returns true when valid. */
  async checkTotp(userId: string, code: string): Promise<boolean> {
    const u = await this.db.one<any>('SELECT totp_secret_enc, totp_last_step FROM users WHERE id = $1', [userId]);
    if (!u?.totp_secret_enc) return false;
    await this.redis.hit(`totp:${userId}`, 10, 300);
    const step = totpVerify(this.crypto.decrypt(u.totp_secret_enc), code);
    if (step === null || (u.totp_last_step !== null && step <= Number(u.totp_last_step))) return false;
    const r = await this.db.query('UPDATE users SET totp_last_step = $2 WHERE id = $1 AND (totp_last_step IS NULL OR totp_last_step < $2)', [userId, step]);
    return (r.rowCount ?? 0) > 0;
  }

  async verifyMfa(userId: string, sessionId: string, code: string) {
    const ok = await this.checkTotp(userId, code);
    if (!ok) throw E.unauthorized('totp_invalid', 'Invalid authenticator code.');
    await this.db.query('UPDATE users SET totp_enabled = true WHERE id = $1 AND totp_secret_enc IS NOT NULL', [userId]);
    await this.db.query('UPDATE sessions SET mfa_verified = true, mfa_verified_at = now() WHERE id = $1 AND user_id = $2', [sessionId, userId]);
    await this.audit.record({ action: 'auth.mfa_verified', resourceType: 'session', resourceId: sessionId });
    const u = await this.db.one<any>('SELECT platform_role FROM users WHERE id = $1', [userId]);
    return { access_token: this.signAccess(userId, sessionId, u.platform_role, true), access_expires_in: this.cfg.ACCESS_TOKEN_TTL_SEC };
  }

  /**
   * High-risk action protection: staff must present a fresh authenticator code for suspend, refund,
   * deletion, legal hold and media-access approval. The code is also bound to the audit reason.
   */
  async requireStepUp(userId: string, code: string | undefined): Promise<void> {
    if (!this.cfg.ADMIN_MFA_REQUIRED) return;
    if (!code) throw E.forbidden('step_up_required', 'This action needs a fresh authenticator code.', { step_up: true });
    if (!(await this.checkTotp(userId, code))) throw E.forbidden('step_up_failed', 'Invalid authenticator code.', { step_up: true });
  }

  clientContext() { const c = requestContext(); return { ip: c?.ip ?? null, ua: c?.userAgent ?? null }; }
}
