import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service';
import { AppConfig, CONFIG } from '../common/config';
import { CryptoService, randomFromAlphabet, randomToken, safeEqual, sha256Hex } from '../common/crypto';
import { E } from '../common/errors';
import { Principal } from '../common/request-context';
import { GuestService } from '../guest/guest.service';
import { Db } from '../infra/db.service';
import { RedisService } from '../infra/redis.service';
import { SettingsService } from '../infra/settings.service';
import { ModerationService } from '../moderation/moderation.service';

export const RightsRequestSchema = z.object({
  type: z.enum(['access', 'erasure', 'removal', 'objection', 'restriction', 'consent_withdrawal']),
  requester_kind: z.enum(['guest', 'host', 'other']).default('other'),
  event_locator: z.string().max(80).optional(),       // upload/gallery token or join code (non-authenticated requesters)
  media_id: z.string().uuid().optional(),
  contact: z.string().trim().max(120).optional(),     // optional reply channel; stored encrypted
  details: z.string().trim().max(2000).optional(),
}).strict();

const TRANSITIONS: Record<string, string[]> = {
  received: ['identity_verification', 'in_progress', 'rejected'],
  identity_verification: ['in_progress', 'rejected'],
  in_progress: ['completed', 'rejected'],
  completed: [], rejected: [],
};

/**
 * Data-subject rights workflow (spec 9.2, 13, 16 "Data rights"): intake -> identity verification -> scope determination ->
 * action -> completion evidence. The SLA (due_at) is a configurable setting; the legal interpretation of response
 * deadlines is flagged for counsel in docs/LEGAL_FLAGS.md and is NOT hard-coded here.
 */
@Injectable()
export class PrivacyService {
  constructor(
    private readonly db: Db, private readonly crypto: CryptoService, private readonly audit: AuditService, private readonly redis: RedisService,
    private readonly guests: GuestService, private readonly moderation: ModerationService, private readonly settings: SettingsService,
    @Inject(CONFIG) private readonly cfg: AppConfig,
  ) {}

  async create(me: Principal, raw: unknown, ip: string | null) {
    const body = RightsRequestSchema.parse(raw);
    await this.redis.hit(`rights:ip:${ip ?? 'x'}`, 10, 3600);
    let eventId: string | null = null; let guestSessionId: string | null = null; let userId: string | null = null; let kind = body.requester_kind;
    if (me.kind === 'guest') { eventId = me.eventId; guestSessionId = me.sessionId; kind = 'guest'; }
    else if (me.kind === 'user') { userId = me.userId; kind = body.requester_kind === 'other' ? 'host' : body.requester_kind; }
    if (!eventId && body.event_locator) eventId = (await this.guests.resolve(body.event_locator)).event.id;

    let mediaId: string | null = null;
    if (body.media_id) {
      const m = await this.db.one<any>('SELECT id, event_id FROM media WHERE id = $1 AND deleted_at IS NULL', [body.media_id]);
      if (!m || (eventId && m.event_id !== eventId)) throw E.notFound('media_not_found');
      mediaId = m.id; eventId = m.event_id;
    }
    const slaDays = await this.settings.get<number>('rights.sla_days', 30);
    const ref = 'RR-' + randomFromAlphabet('ABCDEFGHJKMNPQRSTUVWXYZ23456789', 10);
    const secret = randomToken(18);
    const row = await this.db.tx(async (c) => {
      const r = (await c.query<any>(
        `INSERT INTO rights_requests (ref, access_token_hash, type, requester_kind, contact_enc, event_id, media_id, guest_session_id, user_id, details, due_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now() + ($11 || ' days')::interval) RETURNING *`,
        [ref, sha256Hex(secret), body.type, kind, body.contact ? this.crypto.encrypt(body.contact) : null, eventId, mediaId, guestSessionId, userId, body.details ?? null, String(slaDays)])).rows[0];
      await this.audit.record({ action: 'rights.request_created', resourceType: 'rights_request', resourceId: r.id, eventId, after: { type: body.type, requester_kind: kind, ref } }, c);
      if (body.type === 'consent_withdrawal' && guestSessionId) {
        await c.query(`UPDATE consent_records SET withdrawn_at = now() WHERE guest_session_id = $1 AND purpose = 'event_photo_upload' AND withdrawn_at IS NULL`, [guestSessionId]);
        await c.query(`INSERT INTO consent_records (subject_type, guest_session_id, event_id, purpose, policy_kind, policy_version, locale, action) VALUES ('guest_session',$1,$2,'event_photo_upload','guest_notice','withdrawal','en','withdrawn')`, [guestSessionId, eventId]);
        await c.query(`UPDATE guest_sessions SET scopes = array_remove(scopes, 'upload') WHERE id = $1`, [guestSessionId]); // no further uploads after withdrawal
      }
      return r;
    });
    // "Report / request removal" for a specific photo also flags it for immediate host review.
    if (mediaId && (body.type === 'removal' || body.type === 'erasure' || body.type === 'objection') && me.kind === 'guest') {
      await this.moderation.report(me, mediaId, { reason: 'privacy_concern', details: `rights request ${ref}` }).catch(() => undefined);
    }
    return { ref, access_token: secret, state: row.state, type: row.type, due_at: row.due_at, message_key: 'privacy.request_received' };
  }

  /** Requester inspects their own request with the one-time access token returned at creation. */
  async inspect(ref: string, token: string | undefined) {
    const r = await this.db.one<any>('SELECT * FROM rights_requests WHERE ref = $1', [ref]);
    if (!r || !token || !safeEqual(sha256Hex(token), r.access_token_hash)) throw E.notFound('request_not_found'); // identical failure for unknown ref / bad token
    return {
      ref: r.ref, type: r.type, state: r.state, created_at: r.created_at, due_at: r.due_at, completed_at: r.completed_at, outcome_note: r.outcome_note,
      timeline: (r.evidence as any[]).map((e) => ({ at: e.at, step: e.step })),
    };
  }

  // ------------------------------------------------------------------ staff workflow
  async list(filter: { state?: string; overdue?: boolean }) {
    return this.db.many(
      `SELECT id, ref, type, requester_kind, event_id, media_id, state, due_at, assigned_to, created_at, completed_at, (state NOT IN ('completed','rejected') AND due_at < now()) AS overdue
         FROM rights_requests WHERE ($1::text IS NULL OR state = $1) AND (NOT $2 OR (state NOT IN ('completed','rejected') AND due_at < now())) ORDER BY due_at ASC LIMIT 200`, [filter.state ?? null, !!filter.overdue]);
  }

  async advance(staffId: string, id: string, to: string, note: string | undefined, actions?: { delete_media?: boolean; erase_guest_session?: boolean; erase_user?: boolean }) {
    return this.db.tx(async (c) => {
      const r = (await c.query<any>('SELECT * FROM rights_requests WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!r) throw E.notFound('request_not_found');
      if (!TRANSITIONS[r.state]?.includes(to)) throw E.conflict('invalid_transition', `Cannot move a ${r.state} request to ${to}.`);
      const evidence = [...(r.evidence as any[]), { at: new Date().toISOString(), step: to, by: staffId, note: note ?? null }];
      const jobs: string[] = [];
      if (to === 'completed' && actions) {
        // erasure executes through auditable deletion jobs, never ad-hoc deletes
        const addJob = async (type: string, rid: string) => {
          const j = await c.query(`INSERT INTO deletion_jobs (resource_type, resource_id, event_id, trigger, scheduled_at, requested_by, rights_request_id) VALUES ($1,$2,$3,'rights_request', now(), $4, $5)
                                   ON CONFLICT (resource_type, resource_id) WHERE status IN ('pending','running','held') DO NOTHING RETURNING id`, [type, rid, r.event_id, staffId, r.id]);
          if (j.rows[0]) jobs.push(j.rows[0].id);
        };
        if (actions.delete_media && r.media_id) await addJob('media', r.media_id);
        if (actions.erase_guest_session && r.guest_session_id) await addJob('guest_session', r.guest_session_id);
        if (actions.erase_user && r.user_id) await addJob('user_data', r.user_id);
      }
      await c.query(`UPDATE rights_requests SET state = $2, evidence = $3::jsonb, outcome_note = COALESCE($4, outcome_note), assigned_to = COALESCE(assigned_to, $5),
                            completed_at = CASE WHEN $2 IN ('completed','rejected') THEN now() END WHERE id = $1`, [id, to, JSON.stringify(evidence), note ?? null, staffId]);
      await this.audit.record({ action: `rights.${to}`, resourceType: 'rights_request', resourceId: id, eventId: r.event_id, reason: note ?? null, before: { state: r.state }, after: { state: to, deletion_jobs: jobs } }, c);
      return { id, state: to, deletion_jobs: jobs };
    });
  }

  /** Right of access: assembles what the platform holds for a guest session or a user. Delivered via staff, audited. */
  async accessReport(staffId: string, id: string) {
    const r = await this.db.one<any>('SELECT * FROM rights_requests WHERE id = $1', [id]);
    if (!r) throw E.notFound('request_not_found');
    await this.audit.record({ action: 'rights.access_report_generated', resourceType: 'rights_request', resourceId: id, eventId: r.event_id });
    if (r.guest_session_id) {
      const [s, consents, media] = await Promise.all([
        this.db.one('SELECT id, scopes, display_name, phone_verified_at IS NOT NULL AS phone_verified, upload_count, created_at, expires_at FROM guest_sessions WHERE id = $1', [r.guest_session_id]),
        this.db.many('SELECT purpose, policy_version, action, created_at, withdrawn_at FROM consent_records WHERE guest_session_id = $1 ORDER BY created_at', [r.guest_session_id]),
        this.db.many('SELECT id, upload_state, moderation_state, created_at, width, height FROM media WHERE uploader_session_id = $1 AND deleted_at IS NULL', [r.guest_session_id]),
      ]);
      return { subject: 'guest_session', session: s, consents, uploads: media };
    }
    if (r.user_id) {
      const [u, events, sessions] = await Promise.all([
        this.db.one('SELECT id, display_name, phone_last4, locale, created_at, last_login_at FROM users WHERE id = $1', [r.user_id]),
        this.db.many(`SELECT e.id, e.name, e.state, m.role FROM event_members m JOIN events e ON e.id = m.event_id WHERE m.user_id = $1`, [r.user_id]),
        this.db.many('SELECT id, device_label, created_at, last_used_at FROM sessions WHERE user_id = $1', [r.user_id]),
      ]);
      return { subject: 'user', user: u, events, sessions };
    }
    return { subject: 'unlinked', note: 'Requester is not linked to a stored identity; verify identity through the contact channel.' };
  }

  async policy(kind: string, locale: string) {
    const row = await this.db.one<any>(`SELECT kind, version, locale, title, body, legal_status, effective_at FROM policy_documents WHERE kind = $1 AND locale = $2 ORDER BY effective_at DESC LIMIT 1`, [kind, locale === 'am' ? 'am' : 'en']);
    if (!row) throw E.notFound('policy_not_found');
    return row;
  }
}
