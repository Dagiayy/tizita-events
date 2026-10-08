import { Inject, Injectable } from '@nestjs/common';
import { AnalyticsService } from '../analytics/analytics.service';
import { AuditService } from '../audit/audit.service';
import { AuthService } from '../auth/auth.service';
import { AppConfig, CONFIG } from '../common/config';
import { CryptoService } from '../common/crypto';
import { E } from '../common/errors';
import { normalizeEthiopianPhone } from '../common/phone';
import { Principal } from '../common/request-context';
import { EntitlementsService } from '../events/entitlements.service';
import { assertAllowed } from '../events/lifecycle';
import { LifecycleService } from '../events/lifecycle.service';
import { Db } from '../infra/db.service';
import { QueueService } from '../infra/queue.service';
import { SettingsService } from '../infra/settings.service';
import { StorageService } from '../infra/storage.service';
import { SignedUrlService } from '../media/signed-url.service';
import { ModerationService, ModAction } from '../moderation/moderation.service';
import { NotificationsService } from '../notifications/notifications.service';
import { DeletionService } from '../privacy/deletion.service';

type Staff = Extract<Principal, { kind: 'user' }>;
const OPS_FIELDS = new Set(['uploads_enabled', 'upload_closes_at', 'moderation_mode', 'report_hide_threshold']);

/**
 * Platform administration. Design rules (spec 4, 13, 16, D52):
 *  - search/inspection returns event METADATA only - never media, URLs or guest identities;
 *  - viewing private media requires a reasoned, separately-approved, time-boxed grant, and every view is audited;
 *  - high-risk actions (suspend, refund, legal hold, grant approval, settings) need a fresh authenticator code.
 */
@Injectable()
export class AdminService {
  constructor(
    private readonly db: Db, private readonly audit: AuditService, private readonly auth: AuthService, private readonly crypto: CryptoService,
    private readonly lifecycle: LifecycleService, private readonly ents: EntitlementsService, private readonly settings: SettingsService,
    private readonly queues: QueueService, private readonly storage: StorageService, private readonly notify: NotificationsService,
    private readonly moderation: ModerationService, private readonly deletion: DeletionService, private readonly signer: SignedUrlService,
    private readonly analytics: AnalyticsService, @Inject(CONFIG) private readonly cfg: AppConfig,
  ) {}

  // ------------------------------------------------------------------ dashboard
  async dashboard() {
    const [states, uploads, storage, failed, payments, mod, incidents, queues, sms, kpis] = await Promise.all([
      this.db.many<{ state: string; n: number }>('SELECT state, count(*)::int AS n FROM events GROUP BY state'),
      this.db.many(`SELECT date_trunc('hour', created_at) AS hour, count(*)::int AS n FROM media WHERE created_at > now() - interval '24 hours' GROUP BY 1 ORDER BY 1`),
      this.db.one<any>(`SELECT COALESCE(sum(storage_bytes),0)::bigint AS bytes, COALESCE(sum(media_count),0)::int AS media FROM events WHERE state <> 'deleted'`),
      this.db.one<any>(`SELECT count(*)::int AS n FROM media WHERE upload_state = 'failed' AND created_at > now() - interval '24 hours'`),
      this.db.many(`SELECT state, count(*)::int AS n, COALESCE(sum(amount_etb),0) AS total_etb FROM payment_orders WHERE created_at > now() - interval '30 days' GROUP BY state`),
      this.db.one<any>(`SELECT count(*) FILTER (WHERE status='open')::int AS open_reports, count(*) FILTER (WHERE status='escalated')::int AS escalated FROM moderation_reports`),
      this.db.one<any>(`SELECT count(*) FILTER (WHERE state IN ('open','contained'))::int AS open, count(*) FILTER (WHERE kind='personal_data_breach' AND state IN ('open','contained') AND regulator_notified_at IS NULL)::int AS breach_awaiting_regulator_notice FROM incidents`),
      this.queues.counts(),
      this.notify.smsUsage(7),
      this.analytics.platformKpis(30),
    ]);
    return {
      admin_mfa_required: this.cfg.ADMIN_MFA_REQUIRED,
      active_events: states.filter((s) => ['live', 'scheduled', 'closing'].includes(s.state)).reduce((a, s) => a + s.n, 0),
      events_by_state: Object.fromEntries(states.map((s) => [s.state, s.n])),
      uploads_per_hour_24h: uploads, storage_bytes: Number(storage.bytes), media_count: storage.media, failed_uploads_24h: failed.n,
      payments_30d: payments, sms_usage_7d: sms, moderation: mod, incidents, queues, kpis,
    };
  }

  // ------------------------------------------------------------------ events (metadata only)
  async searchEvents(f: { code?: string; owner_phone?: string; title?: string; city?: string; state?: string; from?: string; to?: string; before?: string; limit?: number }) {
    const where: string[] = []; const p: unknown[] = [];
    const add = (sql: string, v: unknown) => { p.push(v); where.push(sql.replace('?', `$${p.length}`)); };
    if (f.code) add('e.public_code = ?', f.code.toLowerCase());
    if (f.owner_phone) {
      const phone = normalizeEthiopianPhone(f.owner_phone);
      if (!phone) throw E.badRequest('invalid_phone');
      add('u.phone_hash = ?', this.crypto.hmac(phone, 'phone'));
    }
    if (f.title) add('e.name ILIKE ?', `%${f.title.replace(/[%_\\]/g, '\\$&')}%`);
    if (f.city) add('lower(e.city) = ?', f.city.toLowerCase());
    if (f.state) add('e.state = ?', f.state);
    if (f.from) add('e.starts_at >= ?', f.from);
    if (f.to) add('e.starts_at <= ?', f.to);
    if (f.before) add('e.created_at < ?', f.before);
    p.push(Math.min(f.limit ?? 50, 100));
    const rows = await this.db.many<any>(
      `SELECT e.id, e.public_code, e.name, e.type, e.state, e.city, e.starts_at, e.created_at, e.media_count, e.storage_bytes, e.legal_hold, u.phone_last4 AS owner_phone_last4
         FROM events e JOIN users u ON u.id = e.owner_id ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY e.created_at DESC LIMIT $${p.length}`, p);
    return { events: rows };
  }

  async eventDetail(id: string) {
    const e = await this.db.one<any>(
      `SELECT e.*, u.phone_last4, u.status AS owner_status FROM events e JOIN users u ON u.id = e.owner_id WHERE e.id = $1`, [id]);
    if (!e) throw E.notFound('event_not_found');
    const [ent, orders, incidents, deletion, reports] = await Promise.all([
      this.ents.effective(id),
      this.db.many('SELECT id, order_ref, amount_etb, state, provider, created_at, verified_at FROM payment_orders WHERE event_id = $1 ORDER BY created_at DESC LIMIT 20', [id]),
      this.db.many('SELECT id, ref, kind, severity, state, title FROM incidents WHERE event_id = $1 ORDER BY created_at DESC', [id]),
      this.db.many('SELECT id, status, scheduled_at, completed_at, legal_hold FROM deletion_jobs WHERE event_id = $1 ORDER BY created_at DESC', [id]),
      this.db.one<any>(`SELECT count(*) FILTER (WHERE status IN ('open','escalated'))::int AS open FROM moderation_reports WHERE event_id = $1`, [id]),
    ]);
    // Deliberately no media, no guest identities, no share tokens.
    return {
      id: e.id, public_code: e.public_code, name: e.name, type: e.type, state: e.state, city: e.city, region: e.region, starts_at: e.starts_at, ends_at: e.ends_at,
      upload_opens_at: e.upload_opens_at, upload_closes_at: e.upload_closes_at, owner: { phone_last4: e.phone_last4, status: e.owner_status },
      settings: { privacy_mode: e.privacy_mode, upload_access_mode: e.upload_access_mode, gallery_access_mode: e.gallery_access_mode, moderation_mode: e.moderation_mode, uploads_enabled: e.uploads_enabled },
      lifecycle: { closed_at: e.closed_at, retention_until: e.retention_until, deletion_deadline: e.deletion_deadline, legal_hold: e.legal_hold, suspended_at: e.suspended_at, suspended_reason: e.suspended_reason },
      usage: { storage_bytes: e.storage_bytes, media_count: e.media_count, quota: ent.storage_bytes }, entitlement: ent, payments: orders, incidents, deletion_jobs: deletion, open_reports: reports?.open ?? 0,
      media_access: 'requires_grant',
    };
  }

  async suspend(staff: Staff, eventId: string, reason: string, totp?: string) {
    await this.auth.requireStepUp(staff.userId, totp);
    const r = await this.lifecycle.transition(eventId, 'suspended', { trigger: 'staff', reason });
    return { id: r.id, state: r.state };
  }
  async unsuspend(staff: Staff, eventId: string, reason: string, totp?: string) {
    await this.auth.requireStepUp(staff.userId, totp);
    const r = await this.lifecycle.restoreState(eventId, { trigger: 'staff', reason });
    return { id: r.id, state: r.state };
  }
  async archive(staff: Staff, eventId: string, reason: string) {
    const ev = await this.db.one<any>('SELECT state FROM events WHERE id = $1', [eventId]);
    if (!ev) throw E.notFound('event_not_found');
    assertAllowed(ev.state, 'archive');
    const r = await this.lifecycle.transition(eventId, 'archived', { trigger: 'staff', reason });
    return { id: r.id, state: r.state };
  }
  async restore(staff: Staff, eventId: string, reason: string) {
    const ev = await this.db.one<any>('SELECT state FROM events WHERE id = $1', [eventId]);
    if (!ev) throw E.notFound('event_not_found');
    assertAllowed(ev.state, 'restore');
    const r = await this.lifecycle.transition(eventId, 'read_only', { trigger: 'staff', reason });
    return { id: r.id, state: r.state };
  }

  /** Controlled operational change: whitelisted fields only, reason mandatory, before/after audited. */
  async ops(staff: Staff, eventId: string, patch: Record<string, unknown>, reason: string) {
    const keys = Object.keys(patch);
    if (!keys.length || keys.some((k) => !OPS_FIELDS.has(k))) throw E.unprocessable('field_not_allowed', 'Only operational fields can be changed by staff.', { allowed: [...OPS_FIELDS] });
    const ev = await this.db.one<any>('SELECT * FROM events WHERE id = $1', [eventId]);
    if (!ev) throw E.notFound('event_not_found');
    const sets: string[] = []; const params: unknown[] = [eventId];
    for (const [k, v] of Object.entries(patch)) { params.push(v); sets.push(`${k} = $${params.length}`); }
    await this.db.tx(async (c) => {
      await c.query(`UPDATE events SET ${sets.join(', ')}, updated_at = now() WHERE id = $1`, params);
      await this.audit.record({ action: 'admin.event_ops_changed', resourceType: 'event', resourceId: eventId, eventId, reason, before: Object.fromEntries(keys.map((k) => [k, ev[k]])), after: patch }, c);
    });
    return { ok: true };
  }

  async grantPlan(staff: Staff, eventId: string, planCode: string, reason: string, totp?: string) {
    await this.auth.requireStepUp(staff.userId, totp);
    const plan = await this.db.one<any>('SELECT * FROM plans WHERE code = $1', [planCode]);
    const ev = await this.db.one<any>('SELECT * FROM events WHERE id = $1', [eventId]);
    if (!plan || !ev) throw E.notFound();
    await this.db.tx(async (c) => {
      await this.ents.grant(c, eventId, plan, 'staff_grant', null);
      await this.audit.record({ action: 'admin.entitlement_granted', resourceType: 'event', resourceId: eventId, eventId, reason, after: { plan: plan.code } }, c);
    });
    return { ok: true };
  }

  // ------------------------------------------------------------------ elevated media access (4-eyes, time-boxed, audited)
  async requestMediaAccess(staff: Staff, b: { event_id: string; media_id?: string; reason: string; ticket_ref?: string }) {
    const ev = await this.db.one('SELECT 1 FROM events WHERE id = $1', [b.event_id]);
    if (!ev) throw E.notFound('event_not_found');
    const g = await this.db.one<any>(`INSERT INTO media_access_grants (event_id, media_id, requested_by, reason, ticket_ref) VALUES ($1,$2,$3,$4,$5) RETURNING *`, [b.event_id, b.media_id ?? null, staff.userId, b.reason, b.ticket_ref ?? null]);
    await this.audit.record({ action: 'admin.media_access_requested', resourceType: 'event', resourceId: b.event_id, eventId: b.event_id, reason: b.reason, after: { grant_id: g.id, media_id: b.media_id ?? null } });
    return g;
  }
  async decideMediaAccess(staff: Staff, id: string, decision: 'approve' | 'deny' | 'revoke', totp?: string, minutes = 30) {
    if (decision === 'approve') await this.auth.requireStepUp(staff.userId, totp);
    const g = await this.db.one<any>('SELECT * FROM media_access_grants WHERE id = $1', [id]);
    if (!g) throw E.notFound('grant_not_found');
    if (decision === 'approve') {
      if (g.requested_by === staff.userId && !(await this.settings.get<boolean>('admin.allow_self_approval', false))) throw E.forbidden('self_approval_not_allowed', 'A different super admin must approve this request.');
      if (g.state !== 'requested') throw E.conflict('grant_not_pending');
    }
    const to = decision === 'approve' ? 'approved' : decision === 'deny' ? 'denied' : 'revoked';
    const r = await this.db.one<any>(
      `UPDATE media_access_grants SET state = $2, approved_by = $3, decided_at = now(), expires_at = CASE WHEN $2 = 'approved' THEN now() + ($4 || ' minutes')::interval ELSE expires_at END WHERE id = $1 RETURNING *`,
      [id, to, staff.userId, String(Math.min(minutes, 120))]);
    await this.audit.record({ action: `admin.media_access_${to}`, resourceType: 'media_access_grant', resourceId: id, eventId: g.event_id, reason: g.reason });
    return r;
  }
  async listMediaAccess(state?: string) {
    return this.db.many(`SELECT id, event_id, media_id, requested_by, approved_by, reason, ticket_ref, state, expires_at, created_at FROM media_access_grants WHERE ($1::text IS NULL OR state = $1) ORDER BY created_at DESC LIMIT 100`, [state ?? null]);
  }
  /** Lists media for an approved grant with short-lived 'adm' URLs; each URL fetch is audited again at serve time. */
  async mediaForGrant(staff: Staff, grantId: string) {
    const g = await this.db.one<any>(`SELECT * FROM media_access_grants WHERE id = $1 AND requested_by = $2 AND state = 'approved' AND expires_at > now()`, [grantId, staff.userId]);
    if (!g) throw E.forbidden('grant_invalid', 'No active approved grant for you.');
    const rows = await this.db.many<any>(
      `SELECT id, moderation_state, created_at FROM media WHERE event_id = $1 AND upload_state = 'ready' AND deleted_at IS NULL AND ($2::uuid IS NULL OR id = $2) ORDER BY created_at DESC LIMIT 100`, [g.event_id, g.media_id]);
    await this.audit.record({ action: 'admin.media_listed', resourceType: 'event', resourceId: g.event_id, eventId: g.event_id, reason: g.reason, after: { grant_id: g.id, count: rows.length } });
    return { grant_expires_at: g.expires_at, items: rows.map((r) => ({ id: r.id, moderation_state: r.moderation_state, urls: { thumb: this.signer.mediaUrl(r.id, 'thumb', 'adm', { grant: g.id, ttlSec: 300 }), viewer: this.signer.mediaUrl(r.id, 'viewer', 'adm', { grant: g.id, ttlSec: 300 }) } })) };
  }

  // ------------------------------------------------------------------ platform moderation
  async reports(status?: string) {
    return this.db.many(
      `SELECT r.id, r.event_id, r.media_id, r.reason, r.severity, r.status, r.created_at, r.escalated_at, e.public_code, e.name AS event_name
         FROM moderation_reports r JOIN events e ON e.id = r.event_id WHERE ($1::text IS NULL OR r.status = $1) ORDER BY r.severity DESC, r.created_at ASC LIMIT 200`, [status ?? null]);
  }
  /** Platform moderators can restrict content without viewing it; viewing needs a grant. */
  async platformAction(staff: Staff, mediaId: string, action: Exclude<ModAction, 'flag' | 'approve'>, reason: string) {
    const m = await this.db.one<any>('SELECT event_id FROM media WHERE id = $1', [mediaId]);
    if (!m) throw E.notFound('media_not_found');
    const ev = await this.db.one<any>('SELECT * FROM events WHERE id = $1', [m.event_id]);
    const r = await this.db.tx((c) => this.moderation.applyAction(c, ev, mediaId, action, { type: 'staff', id: staff.userId }, reason, true));
    await this.moderation.broadcast(ev, mediaId, r.moderation_state);
    return { id: r.id, moderation_state: r.moderation_state };
  }
  async blockedAndSpikes() {
    const [blocked, spikes, malware] = await Promise.all([
      this.db.many(`SELECT event_id, count(*)::int AS blocked_sessions FROM guest_sessions WHERE blocked_at IS NOT NULL GROUP BY event_id ORDER BY 2 DESC LIMIT 50`),
      this.db.many(`SELECT event_id, count(*)::int AS uploads_10m FROM media WHERE created_at > now() - interval '10 minutes' GROUP BY event_id HAVING count(*) > 200 ORDER BY 2 DESC LIMIT 50`),
      this.db.many(`SELECT event_id, count(*)::int AS n FROM media WHERE failure_code = 'malware_detected' AND created_at > now() - interval '7 days' GROUP BY event_id ORDER BY 2 DESC LIMIT 50`),
    ]);
    return { blocked_sessions: blocked, upload_spikes: spikes, malware_failures: malware };
  }

  // ------------------------------------------------------------------ organizations / users / support
  async organizations() {
    return this.db.many(
      `SELECT o.id, o.legal_name, o.verification_state, o.created_at, count(DISTINCT u.id)::int AS users, count(DISTINCT e.id)::int AS events,
              COALESCE(sum(e.storage_bytes),0)::bigint AS storage_bytes, (SELECT count(*)::int FROM invoices i WHERE i.organization_id = o.id) AS invoices
         FROM organizations o LEFT JOIN users u ON u.organization_id = o.id LEFT JOIN events e ON e.owner_id = u.id GROUP BY o.id ORDER BY o.created_at DESC LIMIT 200`);
  }
  async createOrganization(staff: Staff, b: { legal_name: string; tin?: string; owner_phone?: string }) {
    const o = await this.db.one<any>('INSERT INTO organizations (legal_name, tin) VALUES ($1,$2) RETURNING *', [b.legal_name, b.tin ?? null]);
    if (b.owner_phone) {
      const phone = normalizeEthiopianPhone(b.owner_phone);
      if (phone) await this.db.query('UPDATE users SET organization_id = $2 WHERE phone_hash = $1', [this.crypto.hmac(phone, 'phone'), o.id]);
    }
    await this.audit.record({ action: 'admin.organization_created', resourceType: 'organization', resourceId: o.id });
    return o;
  }
  async setOrganizationVerification(staff: Staff, id: string, state: string, reason: string) {
    const o = await this.db.one<any>('UPDATE organizations SET verification_state = $2 WHERE id = $1 RETURNING *', [id, state]);
    if (!o) throw E.notFound('organization_not_found');
    await this.audit.record({ action: 'admin.organization_verification', resourceType: 'organization', resourceId: id, reason, after: { state } });
    return o;
  }
  async users(q: { phone?: string; limit?: number }) {
    const phone = q.phone ? normalizeEthiopianPhone(q.phone) : null;
    if (q.phone && !phone) throw E.badRequest('invalid_phone');
    return this.db.many(
      `SELECT u.id, u.phone_last4, u.status, u.platform_role, u.created_at, u.last_login_at, u.organization_id,
              (SELECT count(*)::int FROM events e WHERE e.owner_id = u.id) AS events, (SELECT count(*)::int FROM support_tickets t WHERE t.user_id = u.id) AS tickets
         FROM users u WHERE ($1::text IS NULL OR u.phone_hash = $1) ORDER BY u.created_at DESC LIMIT $2`, [phone ? this.crypto.hmac(phone, 'phone') : null, Math.min(q.limit ?? 50, 100)]);
  }
  async setUserStatus(staff: Staff, userId: string, status: 'active' | 'suspended', reason: string, totp?: string) {
    await this.auth.requireStepUp(staff.userId, totp);
    const u = await this.db.one<any>('UPDATE users SET status = $2 WHERE id = $1 AND platform_role = \'none\' RETURNING id, status', [userId, status]);
    if (!u) throw E.notFound('user_not_found');
    if (status === 'suspended') await this.db.query(`UPDATE sessions SET revoked_at = now(), revoke_reason = 'account_suspended' WHERE user_id = $1 AND revoked_at IS NULL`, [userId]);
    await this.audit.record({ action: `admin.user_${status}`, resourceType: 'user', resourceId: userId, reason });
    return u;
  }
  async tickets(status?: string) {
    return this.db.many(`SELECT t.id, t.ref, t.category, t.subject, t.status, t.event_id, t.created_at, u.phone_last4 FROM support_tickets t LEFT JOIN users u ON u.id = t.user_id WHERE ($1::text IS NULL OR t.status = $1) ORDER BY t.created_at DESC LIMIT 200`, [status ?? null]);
  }
  async updateTicket(staff: Staff, id: string, b: { status?: string; assign_to_me?: boolean }) {
    const t = await this.db.one<any>(`UPDATE support_tickets SET status = COALESCE($2, status), assigned_to = CASE WHEN $3 THEN $4 ELSE assigned_to END, updated_at = now() WHERE id = $1 RETURNING *`, [id, b.status ?? null, !!b.assign_to_me, staff.userId]);
    if (!t) throw E.notFound('ticket_not_found');
    await this.audit.record({ action: 'admin.ticket_updated', resourceType: 'support_ticket', resourceId: id, after: b as any });
    return t;
  }

  // ------------------------------------------------------------------ storage
  async storageOverview() {
    const [totals, byState, failed, scans, backups, top, queues] = await Promise.all([
      this.db.one<any>(`SELECT count(*)::int AS media_rows, COALESCE(sum(stored_bytes),0)::bigint AS bytes, (SELECT count(*)::int FROM media_derivatives) AS derivative_objects FROM media WHERE deleted_at IS NULL`),
      this.db.many(`SELECT upload_state, count(*)::int AS n FROM media GROUP BY upload_state`),
      this.db.many(`SELECT failure_code, count(*)::int AS n FROM media WHERE upload_state = 'failed' AND created_at > now() - interval '7 days' GROUP BY failure_code ORDER BY n DESC`),
      this.db.many(`SELECT * FROM storage_scans ORDER BY started_at DESC LIMIT 10`),
      this.db.many(`SELECT id, kind, status, location_label, bytes, encrypted, started_at, finished_at, verified_at, expires_at FROM backup_runs ORDER BY started_at DESC LIMIT 20`),
      this.db.many(`SELECT public_code, name, state, storage_bytes, media_count FROM events WHERE state <> 'deleted' ORDER BY storage_bytes DESC LIMIT 20`),
      this.queues.counts(),
    ]);
    const costPerGb = await this.settings.get<number>('cost.storage_etb_per_gb_month', 0);
    return { totals: { ...totals, bytes: Number(totals.bytes) }, by_state: byState, failed_processing_7d: failed, scans, backups, top_events: top.map((t: any) => ({ ...t, est_monthly_cost_etb: Math.round((Number(t.storage_bytes) / 1073741824) * costPerGb * 100) / 100 })), queues };
  }

  /** Compares object storage with the database and reports (optionally removes) orphans. Read-only unless remove=true. */
  async orphanScan(remove: boolean) {
    const scan = await this.db.one<any>(`INSERT INTO storage_scans (kind) VALUES ('orphan_scan') RETURNING id`);
    let checked = 0; const orphans: string[] = [];
    for await (const o of this.storage.list('media', 'e/')) {
      checked++;
      const m = /^e\/([0-9a-f-]{36})\/m\/([0-9a-f-]{36})\//.exec(o.key);
      if (!m) continue;
      const known = await this.db.one('SELECT 1 FROM media WHERE id = $1 AND event_id = $2 AND deleted_at IS NULL', [m[2], m[1]]);
      if (!known && (!o.lastModified || Date.now() - o.lastModified.getTime() > 3600_000)) orphans.push(o.key);
    }
    let removed = 0;
    if (remove) for (const k of orphans) { await this.storage.delete('media', k).catch(() => undefined); removed++; }
    await this.db.query(`UPDATE storage_scans SET finished_at = now(), objects_checked = $2, orphans_found = $3, orphans_removed = $4, report = $5::jsonb WHERE id = $1`, [scan.id, checked, orphans.length, removed, JSON.stringify({ sample: orphans.slice(0, 20) })]);
    await this.audit.record({ action: 'admin.orphan_scan', resourceType: 'storage', resourceId: scan.id, after: { checked, orphans: orphans.length, removed } });
    return { scan_id: scan.id, checked, orphans: orphans.length, removed };
  }

  // ------------------------------------------------------------------ payments
  async orders(f: { state?: string; provider?: string; limit?: number }) {
    return this.db.many(
      `SELECT o.id, o.order_ref, o.state, o.provider, o.amount_etb, o.created_at, o.verified_at, p.code AS plan_code, e.public_code FROM payment_orders o JOIN plans p ON p.id = o.plan_id JOIN events e ON e.id = o.event_id
        WHERE ($1::text IS NULL OR o.state = $1) AND ($2::text IS NULL OR o.provider = $2) ORDER BY o.created_at DESC LIMIT $3`, [f.state ?? null, f.provider ?? null, Math.min(f.limit ?? 100, 200)]);
  }
  async callbacks(orderRef?: string) {
    return this.db.many(`SELECT id, provider, order_ref, signature_valid, outcome, received_at, processed_at FROM payment_callbacks WHERE ($1::text IS NULL OR order_ref = $1) ORDER BY received_at DESC LIMIT 100`, [orderRef ?? null]);
  }
  async reconciliationRuns() { return this.db.many('SELECT * FROM reconciliation_runs ORDER BY run_date DESC LIMIT 30'); }
  async refunds() { return this.db.many(`SELECT r.*, o.order_ref FROM refunds r JOIN payment_orders o ON o.id = r.order_id ORDER BY r.created_at DESC LIMIT 100`); }
  async invoices() { return this.db.many('SELECT id, number, order_id, amount_etb, tax_rate, tax_amount_etb, tax_status, status, issued_at FROM invoices ORDER BY issued_at DESC LIMIT 200'); }

  // ------------------------------------------------------------------ compliance
  async consents(f: { event_id?: string; limit?: number }) {
    return this.db.many(`SELECT id, subject_type, event_id, purpose, policy_kind, policy_version, action, created_at, withdrawn_at FROM consent_records WHERE ($1::uuid IS NULL OR event_id = $1) ORDER BY created_at DESC LIMIT $2`, [f.event_id ?? null, Math.min(f.limit ?? 100, 500)]);
  }
  async deletionJobs(status?: string) {
    return this.db.many(`SELECT id, resource_type, resource_id, event_id, trigger, scheduled_at, status, legal_hold, attempts, started_at, completed_at, evidence, backup_purge_by, last_error FROM deletion_jobs WHERE ($1::text IS NULL OR status = $1) ORDER BY scheduled_at DESC LIMIT 200`, [status ?? null]);
  }
  async createIncident(staff: Staff, b: any) {
    const discovered = new Date(b.discovered_at);
    const breach = b.kind === 'personal_data_breach';
    const ref = 'INC-' + new Date().getUTCFullYear() + '-' + String(Math.floor(Math.random() * 1e6)).padStart(6, '0');
    const row = await this.db.one<any>(
      `INSERT INTO incidents (ref, kind, severity, title, description, event_id, discovered_at, regulator_notify_due_at, subjects_notify_due_at, data_categories, approx_subjects, approx_records, commander_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
      [ref, b.kind, b.severity, b.title, b.description ?? null, b.event_id ?? null, discovered, breach ? new Date(discovered.getTime() + 72 * 3600_000) : null, breach ? new Date(discovered.getTime() + 72 * 3600_000) : null,
        b.data_categories ?? [], b.approx_subjects ?? null, b.approx_records ?? null, b.commander_id ?? staff.userId, staff.userId]);
    await this.db.query('INSERT INTO incident_log (incident_id, actor_id, entry) VALUES ($1,$2,$3)', [row.id, staff.userId, `Incident recorded. Discovery time (clock start): ${discovered.toISOString()}`]);
    await this.audit.record({ action: 'incident.created', resourceType: 'incident', resourceId: row.id, eventId: b.event_id ?? null, after: { ref, kind: b.kind, severity: b.severity } });
    return this.incidentDto(row);
  }
  incidentDto(r: any) {
    const due = r.regulator_notify_due_at ? new Date(r.regulator_notify_due_at).getTime() : null;
    return { ...r, regulator_hours_remaining: due && !r.regulator_notified_at ? Math.round(((due - Date.now()) / 3600_000) * 10) / 10 : null,
      regulator_overdue: !!due && !r.regulator_notified_at && due < Date.now() };
  }
  async incidents(state?: string) {
    return (await this.db.many<any>(`SELECT * FROM incidents WHERE ($1::text IS NULL OR state = $1) ORDER BY discovered_at DESC LIMIT 200`, [state ?? null])).map((r) => this.incidentDto(r));
  }
  async incident(id: string) {
    const r = await this.db.one<any>('SELECT * FROM incidents WHERE id = $1', [id]);
    if (!r) throw E.notFound('incident_not_found');
    return { ...this.incidentDto(r), log: await this.db.many('SELECT actor_id, entry, created_at FROM incident_log WHERE incident_id = $1 ORDER BY created_at', [id]) };
  }
  async updateIncident(staff: Staff, id: string, b: any) {
    const cur = await this.db.one<any>('SELECT * FROM incidents WHERE id = $1', [id]);
    if (!cur) throw E.notFound('incident_not_found');
    const row = await this.db.one<any>(
      `UPDATE incidents SET state = COALESCE($2, state), regulator_notified_at = COALESCE($3, regulator_notified_at), subjects_notified_at = COALESCE($4, subjects_notified_at),
              postmortem = COALESCE($5, postmortem), severity = COALESCE($6, severity), updated_at = now() WHERE id = $1 RETURNING *`,
      [id, b.state ?? null, b.regulator_notified_at ?? null, b.subjects_notified_at ?? null, b.postmortem ?? null, b.severity ?? null]);
    if (b.entry) await this.db.query('INSERT INTO incident_log (incident_id, actor_id, entry) VALUES ($1,$2,$3)', [id, staff.userId, b.entry]);
    await this.audit.record({ action: 'incident.updated', resourceType: 'incident', resourceId: id, before: { state: cur.state }, after: { state: row.state, regulator_notified: !!row.regulator_notified_at } });
    return this.incidentDto(row);
  }
  async vendors() { return this.db.many('SELECT * FROM vendors ORDER BY name'); }
  async upsertVendor(staff: Staff, b: any) {
    const v = await this.db.one<any>(
      `INSERT INTO vendors (name, purpose, data_categories, data_location, outside_ethiopia, subprocessors, retention, dpa_signed, transfer_assessment_ref, breach_contact, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (name) DO UPDATE SET purpose = EXCLUDED.purpose, data_categories = EXCLUDED.data_categories, data_location = EXCLUDED.data_location, outside_ethiopia = EXCLUDED.outside_ethiopia,
         subprocessors = EXCLUDED.subprocessors, retention = EXCLUDED.retention, dpa_signed = EXCLUDED.dpa_signed, transfer_assessment_ref = EXCLUDED.transfer_assessment_ref, breach_contact = EXCLUDED.breach_contact, status = EXCLUDED.status, updated_at = now()
       RETURNING *`,
      [b.name, b.purpose, b.data_categories ?? [], b.data_location, !!b.outside_ethiopia, b.subprocessors ?? null, b.retention ?? null, !!b.dpa_signed, b.transfer_assessment_ref ?? null, b.breach_contact ?? null, b.status ?? 'planned']);
    // an external vendor cannot be activated without a recorded transfer assessment and DPA
    if (v.outside_ethiopia && v.status === 'active' && (!v.transfer_assessment_ref || !v.dpa_signed)) {
      await this.db.query(`UPDATE vendors SET status = 'planned' WHERE id = $1`, [v.id]);
      throw E.unprocessable('transfer_assessment_required', 'A vendor that processes data outside Ethiopia needs a signed DPA and a transfer assessment reference before activation.');
    }
    await this.audit.record({ action: 'admin.vendor_upserted', resourceType: 'vendor', resourceId: v.id, after: { name: v.name, status: v.status, outside_ethiopia: v.outside_ethiopia } });
    return v;
  }

  // ------------------------------------------------------------------ plans & settings
  async plans() { return this.db.many('SELECT * FROM plans ORDER BY sort_order'); }
  async upsertPlan(staff: Staff, code: string, b: any, totp?: string) {
    await this.auth.requireStepUp(staff.userId, totp);
    const cur = await this.db.one<any>('SELECT * FROM plans WHERE code = $1', [code]);
    if (!cur) throw E.notFound('plan_not_found');
    const fields = ['price_etb', 'storage_bytes', 'max_media', 'retention_days', 'original_storage', 'allow_original_export', 'max_collaborators', 'photographer_seats', 'concurrent_uploads', 'branding', 'watermark', 'active', 'name_en', 'name_am'];
    const sets: string[] = []; const params: unknown[] = [code];
    for (const k of fields) if (b[k] !== undefined) { params.push(b[k]); sets.push(`${k} = $${params.length}`); }
    if (!sets.length) return cur;
    const r = await this.db.one<any>(`UPDATE plans SET ${sets.join(', ')} WHERE code = $1 RETURNING *`, params); // existing entitlements are unaffected (snapshotted)
    await this.audit.record({ action: 'admin.plan_updated', resourceType: 'plan', resourceId: cur.id, before: Object.fromEntries(Object.keys(b).filter((k) => fields.includes(k)).map((k) => [k, cur[k]])), after: b });
    return r;
  }
  async setSetting(staff: Staff, key: string, value: unknown, reason: string, totp?: string) {
    await this.auth.requireStepUp(staff.userId, totp);
    if (!/^[a-z_.]{3,60}$/.test(key)) throw E.badRequest('invalid_key');
    const before = await this.settings.get(key, null);
    await this.settings.set(key, value, staff.userId);
    await this.audit.record({ action: 'admin.setting_changed', resourceType: 'system_setting', resourceId: key, reason, before: { value: before as any }, after: { value: value as any } });
    return { ok: true };
  }
}
