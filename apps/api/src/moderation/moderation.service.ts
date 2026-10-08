import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { AnalyticsService } from '../analytics/analytics.service';
import { AuditService } from '../audit/audit.service';
import { AppConfig, CONFIG } from '../common/config';
import { E } from '../common/errors';
import { Principal } from '../common/request-context';
import { AccessService } from '../events/access.service';
import { assertAllowed, stateAllows } from '../events/lifecycle';
import { RealtimeService } from '../gallery/realtime.service';
import { Db, Q } from '../infra/db.service';
import { RedisService } from '../infra/redis.service';
import { StorageService, keys } from '../infra/storage.service';
import { SignedUrlService } from '../media/signed-url.service';

export type ModAction = 'approve' | 'reject' | 'hide' | 'restore' | 'flag' | 'delete';
export const REPORT_REASONS = ['inappropriate', 'privacy_concern', 'impersonation', 'copyright', 'other'] as const;
const SEVERITY: Record<(typeof REPORT_REASONS)[number], number> = { inappropriate: 3, privacy_concern: 3, impersonation: 2, copyright: 2, other: 1 };

/** Allowed media moderation transitions (spec 8.1 media states). */
const FLOW: Record<string, Partial<Record<ModAction, string>>> = {
  pending: { approve: 'approved', reject: 'rejected', delete: 'deleted' },
  approved: { hide: 'hidden', flag: 'flagged', reject: 'rejected', delete: 'deleted' },
  flagged: { approve: 'approved', restore: 'approved', hide: 'hidden', reject: 'rejected', delete: 'deleted' },
  hidden: { restore: 'approved', approve: 'approved', reject: 'rejected', delete: 'deleted' },
  rejected: { approve: 'approved', restore: 'approved', delete: 'deleted' },
};

export const ReportSchema = z.object({ reason: z.enum(REPORT_REASONS), details: z.string().trim().max(500).optional() }).strict();

@Injectable()
export class ModerationService {
  constructor(
    private readonly db: Db,
    private readonly access: AccessService,
    private readonly audit: AuditService,
    private readonly realtime: RealtimeService,
    private readonly analytics: AnalyticsService,
    private readonly storage: StorageService,
    private readonly redis: RedisService,
    private readonly signer: SignedUrlService,
    @Inject(CONFIG) private readonly cfg: AppConfig,
  ) {}

  // ------------------------------------------------------------------ queue
  async queue(me: Principal, eventId: string) {
    await this.access.requireMember(me, eventId, 'media.moderate');
    const rows = await this.db.many<any>(
      `SELECT m.id, m.moderation_state, m.created_at, m.width, m.height, m.caption, m.near_dup_of_media_id IS NOT NULL AS near_duplicate,
              COALESCE((SELECT json_agg(json_build_object('id', r.id, 'reason', r.reason, 'status', r.status, 'severity', r.severity, 'created_at', r.created_at) ORDER BY r.created_at)
                 FROM moderation_reports r WHERE r.media_id = m.id AND r.status IN ('open','escalated')), '[]'::json) AS reports
         FROM media m WHERE m.event_id = $1 AND m.deleted_at IS NULL AND m.upload_state = 'ready' AND m.moderation_state IN ('pending','flagged')
        ORDER BY (m.moderation_state = 'flagged') DESC, m.created_at ASC LIMIT 200`, [eventId]);
    const counts = await this.db.one<any>(
      `SELECT count(*) FILTER (WHERE moderation_state='pending')::int AS pending, count(*) FILTER (WHERE moderation_state='flagged')::int AS flagged
         FROM media WHERE event_id = $1 AND deleted_at IS NULL AND upload_state='ready'`, [eventId]);
    return {
      counts,
      items: rows.map((r) => ({
        ...r, urls: { thumb: this.signer.mediaUrl(r.id, 'thumb', 'stf'), viewer: this.signer.mediaUrl(r.id, 'viewer', 'stf') },
      })),
    };
  }

  // ------------------------------------------------------------------ actions
  async act(me: Principal, mediaId: string, action: ModAction, reason?: string) {
    const m = await this.db.one<any>('SELECT id, event_id FROM media WHERE id = $1', [mediaId]);
    if (!m) throw E.notFound('media_not_found');
    const { event, role } = await this.access.requireMember(me, m.event_id, 'media.moderate');
    assertAllowed(event.state, 'moderate');
    if (role === 'photographer') throw E.forbidden('insufficient_event_role');
    return this.db.tx((c) => this.applyAction(c, event, mediaId, action, { type: 'user', id: (me as any).userId }, reason));
  }

  async bulk(me: Principal, eventId: string, action: Exclude<ModAction, 'flag'>, mediaIds: string[], reason?: string) {
    const { event } = await this.access.requireMember(me, eventId, 'media.moderate');
    assertAllowed(event.state, 'moderate');
    if (mediaIds.length > 200) throw E.badRequest('too_many_items', 'At most 200 items per request.');
    const results: { id: string; ok: boolean; state?: string; error?: string }[] = [];
    await this.db.tx(async (c) => {
      for (const id of mediaIds) {
        try {
          await c.query('SAVEPOINT s');
          const r = await this.applyAction(c, event, id, action, { type: 'user', id: (me as any).userId }, reason, true);
          await c.query('RELEASE SAVEPOINT s');
          results.push({ id, ok: true, state: r.moderation_state });
        } catch (e) {
          await c.query('ROLLBACK TO SAVEPOINT s');
          results.push({ id, ok: false, error: (e as any)?.code ?? 'error' });
        }
      }
      await this.audit.record({ action: `moderation.bulk_${action}`, resourceType: 'event', resourceId: eventId, eventId, reason: reason ?? null, after: { requested: mediaIds.length, succeeded: results.filter((r) => r.ok).length } }, c);
    });
    for (const r of results.filter((x) => x.ok)) await this.broadcast(event, r.id, r.state!);
    return { results };
  }

  /** Core transition. Used by hosts, moderators, the report pipeline and platform staff. */
  async applyAction(q: Q, event: any, mediaId: string, action: ModAction, actor: { type: 'user' | 'staff' | 'system' | 'guest'; id?: string | null }, reason?: string, deferBroadcast = false) {
    const m = (await q.query<any>('SELECT * FROM media WHERE id = $1 AND event_id = $2 FOR UPDATE', [mediaId, event.id])).rows[0];
    if (!m || m.deleted_at) throw E.notFound('media_not_found');
    if (m.upload_state !== 'ready') throw E.conflict('media_not_ready', 'This photo is still being processed.');
    const to = FLOW[m.moderation_state]?.[action];
    if (!to) throw E.conflict('invalid_media_transition', `Cannot ${action} a ${m.moderation_state} photo.`, { from: m.moderation_state, action });
    const upd = (await q.query<any>(
      `UPDATE media SET moderation_state = $2, moderated_at = now(), moderated_by = $3,
              published_at = CASE WHEN $2 = 'approved' THEN COALESCE(published_at, now()) ELSE published_at END,
              deleted_at = CASE WHEN $2 = 'deleted' THEN now() ELSE deleted_at END
        WHERE id = $1 RETURNING *`, [mediaId, to, actor.type === 'user' || actor.type === 'staff' ? actor.id ?? null : null])).rows[0];
    await q.query(`INSERT INTO moderation_logs (event_id, media_id, actor_type, actor_id, action, from_state, to_state, reason) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [event.id, mediaId, actor.type, actor.id ?? null, action, m.moderation_state, to, reason ?? null]);
    if (m.moderation_state === 'flagged' && (to === 'approved' || to === 'rejected' || to === 'hidden')) {
      await q.query(`UPDATE moderation_reports SET status = $2, action = $3, reviewer_id = $4, reviewer_scope = $5, resolved_at = now() WHERE media_id = $1 AND status IN ('open','escalated')`,
        [mediaId, to === 'approved' ? 'dismissed' : 'actioned', action, actor.type === 'user' || actor.type === 'staff' ? actor.id ?? null : null, actor.type === 'staff' ? 'platform' : 'host']);
    }
    if (to === 'deleted') await this.purgeMediaObjects(q, upd);
    await this.audit.record({ action: `moderation.${action}`, resourceType: 'media', resourceId: mediaId, eventId: event.id, reason: reason ?? null, before: { state: m.moderation_state }, after: { state: to },
      ...(actor.type === 'system' ? { actor: { type: 'system' as const } } : {}) }, q);
    if (to === 'approved') this.analytics.inc(event.id, 'approved');
    if (!deferBroadcast) await this.broadcast(event, mediaId, to);
    return upd;
  }

  /** Realtime: staff channel sees everything; the public channel only ever learns about approvals (with URLs) and removals (id only). */
  async broadcast(event: any, mediaId: string, to: string): Promise<void> {
    this.realtime.publish(event.id, 'staff', { type: 'media.updated', media_id: mediaId, moderation_state: to, upload_state: 'ready' });
    if (to === 'approved') {
      const m = await this.db.one<any>(
        `SELECT m.id, m.width, m.height, m.published_at, f.publication_state FROM media m LEFT JOIN event_folders f ON f.id = m.folder_id WHERE m.id = $1`, [mediaId]);
      if (m && (!m.publication_state || m.publication_state === 'published')) {
        this.realtime.publish(event.id, 'public', { type: 'media.published', media: { id: m.id, width: m.width, height: m.height, published_at: m.published_at,
          urls: { thumb: this.signer.mediaUrl(m.id, 'thumb', 'pub'), gallery: this.signer.mediaUrl(m.id, 'gallery', 'pub'), viewer: this.signer.mediaUrl(m.id, 'viewer', 'pub') } } });
      }
    } else {
      this.realtime.publish(event.id, 'public', { type: 'media.removed', media_id: mediaId });
    }
  }

  private async purgeMediaObjects(q: Q, media: any): Promise<void> {
    const derivs = (await q.query<{ object_key: string; byte_size: number }>('SELECT object_key, byte_size FROM media_derivatives WHERE media_id = $1', [media.id])).rows;
    for (const d of derivs) await this.storage.delete('media', d.object_key).catch(() => undefined);
    await q.query('DELETE FROM media_derivatives WHERE media_id = $1', [media.id]);
    await q.query('UPDATE events SET storage_bytes = GREATEST(0, storage_bytes - $2), media_count = GREATEST(0, media_count - 1) WHERE id = $1', [media.event_id, media.stored_bytes ?? 0]);
    await q.query('UPDATE media SET stored_bytes = 0, original_key = NULL WHERE id = $1', [media.id]);
    void keys;
  }

  /** Host/moderator edits: highlight, folder, caption. */
  async patchMedia(me: Principal, mediaId: string, body: { is_highlight?: boolean; folder_id?: string | null; caption?: string | null }) {
    const m = await this.db.one<any>('SELECT * FROM media WHERE id = $1 AND deleted_at IS NULL', [mediaId]);
    if (!m) throw E.notFound('media_not_found');
    const { event, role, userId } = await this.access.requireMember(me, m.event_id, 'media.view_own');
    if (role === 'photographer' && m.uploader_user_id !== userId) throw E.forbidden('insufficient_event_role');
    if (body.folder_id) {
      const f = await this.db.one('SELECT 1 FROM event_folders WHERE id = $1 AND event_id = $2', [body.folder_id, m.event_id]);
      if (!f) throw E.unprocessable('invalid_folder');
    }
    const sets: string[] = []; const params: unknown[] = [mediaId];
    for (const [k, v] of Object.entries(body)) { params.push(v); sets.push(`${k} = $${params.length}`); }
    if (!sets.length) return { ok: true };
    await this.db.query(`UPDATE media SET ${sets.join(', ')} WHERE id = $1`, params);
    await this.audit.record({ action: 'media.updated', resourceType: 'media', resourceId: mediaId, eventId: m.event_id, after: body as any });
    this.realtime.publish(event.id, 'staff', { type: 'media.updated', media_id: mediaId });
    return { ok: true };
  }

  // ------------------------------------------------------------------ reporting (guests and members)
  async report(me: Principal, mediaId: string, raw: unknown) {
    const body = ReportSchema.parse(raw);
    if (me.kind === 'anon') throw E.unauthorized();
    // a repeated report from the same session is acknowledged without side effects (even if the photo is already flagged/hidden)
    if (me.kind === 'guest') {
      const dup = await this.db.one('SELECT 1 FROM moderation_reports WHERE media_id = $1 AND reporter_session_id = $2', [mediaId, me.sessionId]);
      if (dup) return { ok: true, message_key: 'report.received' };
    }
    const m = await this.db.one<any>(
      `SELECT m.*, e.state AS event_state, e.report_hide_threshold, f.publication_state FROM media m JOIN events e ON e.id = m.event_id LEFT JOIN event_folders f ON f.id = m.folder_id
        WHERE m.id = $1 AND m.deleted_at IS NULL`, [mediaId]);
    // Guests can only report what they could see; failure is indistinguishable from "not found".
    if (!m) throw E.notFound('media_not_found');
    if (me.kind === 'guest') {
      if (m.event_id !== me.eventId || !me.scopes.includes('gallery') || m.upload_state !== 'ready' || m.moderation_state !== 'approved' || (m.folder_id && m.publication_state !== 'published')) throw E.notFound('media_not_found');
      await this.redis.hit(`report:${me.sessionId}`, this.cfg.RATE_LIMIT_REPORT_PER_SESSION, 3600);
    } else {
      await this.access.requireMember(me, m.event_id, 'event.view');
      await this.redis.hit(`report:u:${me.userId}`, 60, 3600);
    }
    const sessionId = me.kind === 'guest' ? me.sessionId : null;
    const userId = me.kind === 'user' ? me.userId : null;
    const event = await this.db.one<any>('SELECT * FROM events WHERE id = $1', [m.event_id]);
    await this.db.tx(async (c) => {
      const ins = await c.query(
        `INSERT INTO moderation_reports (event_id, media_id, reporter_session_id, reporter_user_id, reason, details, severity) VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (media_id, reporter_session_id) WHERE reporter_session_id IS NOT NULL AND status = 'open' DO NOTHING RETURNING id`,
        [m.event_id, mediaId, sessionId, userId, body.reason, body.details ?? null, SEVERITY[body.reason]]);
      if (!ins.rows[0]) return; // repeated report from the same session is a no-op
      await this.audit.record({ action: 'report.created', resourceType: 'media', resourceId: mediaId, eventId: m.event_id, after: { reason: body.reason } }, c);
      const distinct = (await c.query<{ n: number; sev: number }>(
        `SELECT count(DISTINCT COALESCE(reporter_session_id::text, reporter_user_id::text))::int AS n, max(severity) AS sev FROM moderation_reports WHERE media_id = $1 AND status IN ('open','escalated')`, [mediaId])).rows[0];
      if (m.moderation_state === 'approved' && distinct.n >= m.report_hide_threshold) {
        await this.applyAction(c, event, mediaId, 'flag', { type: 'system' }, `auto-flagged after ${distinct.n} report(s)`, true);
      }
      // abuse escalation: multiple independent reports of serious content go to the platform queue
      if (distinct.n >= 3 && distinct.sev >= 3) {
        await c.query(`UPDATE moderation_reports SET status = 'escalated', escalated_at = now() WHERE media_id = $1 AND status = 'open'`, [mediaId]);
        await this.audit.record({ action: 'report.auto_escalated', resourceType: 'media', resourceId: mediaId, eventId: m.event_id, actor: { type: 'system' }, after: { reporters: distinct.n } }, c);
      }
    });
    const cur = await this.db.one<any>('SELECT moderation_state FROM media WHERE id = $1', [mediaId]);
    if (cur?.moderation_state === 'flagged') await this.broadcast(event, mediaId, 'flagged');
    // reporter gets a generic acknowledgement - no moderator details
    return { ok: true, message_key: 'report.received' };
  }

  async listReports(me: Principal, eventId: string, status?: string) {
    await this.access.requireMember(me, eventId, 'media.moderate');
    return { reports: await this.db.many(
      `SELECT r.id, r.media_id, r.reason, r.details, r.severity, r.status, r.action, r.created_at, r.resolved_at FROM moderation_reports r
        WHERE r.event_id = $1 AND ($2::text IS NULL OR r.status = $2) ORDER BY r.created_at DESC LIMIT 200`, [eventId, status ?? null]) };
  }

  async escalate(me: Principal, reportId: string, note?: string) {
    const r = await this.db.one<any>('SELECT * FROM moderation_reports WHERE id = $1', [reportId]);
    if (!r) throw E.notFound('report_not_found');
    await this.access.requireMember(me, r.event_id, 'media.moderate');
    await this.db.query(`UPDATE moderation_reports SET status = 'escalated', escalated_at = now() WHERE id = $1 AND status = 'open'`, [reportId]);
    await this.audit.record({ action: 'report.escalated', resourceType: 'report', resourceId: reportId, eventId: r.event_id, reason: note ?? null });
    return { ok: true };
  }

  async logs(me: Principal, eventId: string, before?: string) {
    await this.access.requireMember(me, eventId, 'media.moderate');
    return { logs: await this.db.many(
      `SELECT id, media_id, actor_type, action, from_state, to_state, reason, created_at FROM moderation_logs
        WHERE event_id = $1 AND ($2::timestamptz IS NULL OR created_at < $2) ORDER BY created_at DESC LIMIT 100`, [eventId, before ?? null]) };
  }

  // ------------------------------------------------------------------ blocking
  /** Blocks a guest session (and its device) from uploading further; optionally hides everything they posted. */
  async blockUploader(me: Principal, eventId: string, sessionId: string, opts: { hide_media?: boolean; reason?: string }) {
    const { event } = await this.access.requireMember(me, eventId, 'guest.block');
    const s = await this.db.one<any>('SELECT * FROM guest_sessions WHERE id = $1 AND event_id = $2', [sessionId, eventId]);
    if (!s) throw E.notFound('session_not_found');
    const hidden: string[] = [];
    await this.db.tx(async (c) => {
      await c.query('UPDATE guest_sessions SET blocked_at = now(), block_reason = $2 WHERE id = $1', [sessionId, opts.reason ?? null]);
      if (s.device_hash) await c.query('INSERT INTO blocked_devices (event_id, device_hash, reason, created_by) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING', [eventId, s.device_hash, opts.reason ?? null, (me as any).userId]);
      if (opts.hide_media) {
        const rows = (await c.query<{ id: string }>(`SELECT id FROM media WHERE event_id = $1 AND uploader_session_id = $2 AND moderation_state IN ('approved','pending','flagged') AND upload_state = 'ready' AND deleted_at IS NULL`, [eventId, sessionId])).rows;
        for (const r of rows) {
          const cur = (await c.query<{ moderation_state: string }>('SELECT moderation_state FROM media WHERE id = $1', [r.id])).rows[0].moderation_state;
          await this.applyAction(c, event, r.id, cur === 'pending' ? 'reject' : 'hide', { type: 'user', id: (me as any).userId }, 'uploader blocked', true);
          hidden.push(r.id);
        }
      }
      await c.query(`UPDATE media SET upload_state = 'cancelled', failure_code = 'uploader_blocked' WHERE uploader_session_id = $1 AND upload_state IN ('intent','uploading')`, [sessionId]);
      await this.audit.record({ action: 'guest.blocked', resourceType: 'guest_session', resourceId: sessionId, eventId, reason: opts.reason ?? null, after: { hidden_media: hidden.length } }, c);
    });
    for (const id of hidden) await this.broadcast(event, id, 'hidden');
    return { ok: true, hidden: hidden.length };
  }

  async blockUploaderByMedia(me: Principal, mediaId: string, opts: { hide_media?: boolean; reason?: string }) {
    const m = await this.db.one<any>('SELECT event_id, uploader_session_id FROM media WHERE id = $1', [mediaId]);
    if (!m || !m.uploader_session_id) throw E.notFound('uploader_not_found');
    return this.blockUploader(me, m.event_id, m.uploader_session_id, opts);
  }

  // ------------------------------------------------------------------ guest self-delete (D64)
  async guestDelete(me: Principal, mediaId: string) {
    if (me.kind !== 'guest') throw E.unauthorized();
    const m = await this.db.one<any>('SELECT * FROM media WHERE id = $1 AND event_id = $2 AND uploader_session_id = $3 AND deleted_at IS NULL', [mediaId, me.eventId, me.sessionId]);
    if (!m) throw E.notFound('media_not_found');
    const event = await this.db.one<any>('SELECT * FROM events WHERE id = $1', [me.eventId]);
    if (m.upload_state !== 'ready') {
      await this.db.query(`UPDATE media SET upload_state = 'cancelled', failure_code = 'deleted_by_uploader', deleted_at = now() WHERE id = $1`, [mediaId]);
      return { ok: true };
    }
    if (!stateAllows(event.state, 'guest_view') && event.state !== 'scheduled') throw E.conflict('event_state_forbids', 'This event no longer allows changes.');
    await this.db.tx((c) => this.applyAction(c, event, mediaId, 'delete', { type: 'guest', id: me.sessionId }, 'deleted by uploader'));
    return { ok: true };
  }
}
