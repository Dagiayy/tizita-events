import { Inject, Injectable, Logger } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { AppConfig, CONFIG } from '../common/config';
import { E } from '../common/errors';
import { Db, Q } from '../infra/db.service';
import { SettingsService } from '../infra/settings.service';
import { RealtimeService } from '../gallery/realtime.service';
import { NotificationsService } from '../notifications/notifications.service';
import { EntitlementsService } from './entitlements.service';
import { EventState, canTransition, stateFromClock } from './lifecycle';

export interface TransitionOpts {
  trigger: 'host' | 'staff' | 'system' | 'payment' | 'retention' | 'schedule';
  reason?: string;
  q?: Q;
  /** extra columns applied atomically with the transition (whitelisted by caller) */
  patch?: Record<string, unknown>;
  deletionTrigger?: 'host_request' | 'retention_expiry' | 'staff' | 'rights_request';
  requestedBy?: string | null;
}

@Injectable()
export class LifecycleService {
  private readonly log = new Logger('Lifecycle');
  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
    private readonly realtime: RealtimeService,
    private readonly ents: EntitlementsService,
    private readonly settings: SettingsService,
    private readonly notify: NotificationsService,
    @Inject(CONFIG) private readonly cfg: AppConfig,
  ) {}

  /** The single place where event.state changes. Locks the row, validates the transition, audits it. */
  async transition(eventId: string, to: EventState, opts: TransitionOpts): Promise<any> {
    const run = async (q: Q) => {
      const cur = (await q.query<any>('SELECT * FROM events WHERE id = $1 FOR UPDATE', [eventId])).rows[0];
      if (!cur) throw E.notFound('event_not_found');
      const from = cur.state as EventState;
      if (from === to) return cur;
      if (!canTransition(from, to)) throw E.conflict('invalid_state_transition', `Event cannot move from "${from}" to "${to}".`, { from, to });

      const sets: string[] = ['state = $2', 'updated_at = now()'];
      const params: unknown[] = [eventId, to];
      const set = (col: string, expr: string, v?: unknown) => { if (v !== undefined) { params.push(v); sets.push(`${col} = ${expr.replace('?', `$${params.length}`)}`); } else sets.push(`${col} = ${expr}`); };

      if (to === 'closing') set('closed_at', 'COALESCE(closed_at, now())');
      if (to === 'read_only') {
        set('read_only_at', 'COALESCE(read_only_at, now())');
        set('archived_at', 'NULL');
        const ent = await this.ents.effective(eventId, q);
        const days = ent.has_package ? ent.retention_days : await this.settings.get<number>('retention.default_days', this.cfg.RETENTION_DEFAULT_DAYS);
        set('retention_until', `COALESCE(closed_at, now()) + ($${params.length + 1} || ' days')::interval`, String(days));
      }
      if (to === 'archived') set('archived_at', 'now()');
      if (to === 'suspended') { set('prev_state', '?', from); set('suspended_at', 'now()'); if (opts.reason) set('suspended_reason', '?', opts.reason); }
      if (from === 'suspended') { set('suspended_at', 'NULL'); set('suspended_reason', 'NULL'); }
      if (to === 'deletion_pending') {
        const grace = Math.min(30, Math.max(7, await this.settings.get<number>('deletion.grace_days', this.cfg.DELETION_GRACE_DAYS)));
        if (from !== 'suspended') set('prev_state', '?', from);
        set('deletion_requested_at', 'now()');
        set('deletion_deadline', `now() + ($${params.length + 1} || ' days')::interval`, String(grace));
      }
      if (from === 'deletion_pending' && to !== 'deleted') {
        set('deletion_requested_at', 'NULL'); set('deletion_deadline', 'NULL');
      }
      if (to === 'deleted') set('deleted_at', 'now()');
      for (const [k, v] of Object.entries(opts.patch ?? {})) {
        if (!/^[a-z_]+$/.test(k)) throw new Error('invalid patch column');
        set(k, '?', v);
      }

      const upd = (await q.query<any>(`UPDATE events SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, params)).rows[0];

      if (to === 'deletion_pending') {
        await q.query(
          `INSERT INTO deletion_jobs (resource_type, resource_id, event_id, trigger, scheduled_at, requested_by, legal_hold, backup_purge_by)
           VALUES ('event', $1, $1, $2, $3::timestamptz, $4, $5, $3::timestamptz + ($6 || ' days')::interval)
           ON CONFLICT (resource_type, resource_id) WHERE status IN ('pending','running','held') DO NOTHING`,
          [eventId, opts.deletionTrigger ?? 'host_request', upd.deletion_deadline, opts.requestedBy ?? null, upd.legal_hold, String(this.cfg.BACKUP_RETENTION_DAYS)]);
      }
      if (from === 'deletion_pending' && to !== 'deleted') {
        await q.query(`UPDATE deletion_jobs SET status = 'cancelled' WHERE resource_type = 'event' AND resource_id = $1 AND status IN ('pending','held')`, [eventId]);
      }
      await this.audit.record({
        action: `event.state.${from}_to_${to}`, resourceType: 'event', resourceId: eventId, eventId, reason: opts.reason ?? null,
        before: { state: from }, after: { state: to, trigger: opts.trigger },
        ...(opts.trigger === 'system' || opts.trigger === 'schedule' || opts.trigger === 'retention' ? { actor: { type: 'system' as const } } : {}),
      }, q);
      return { ...upd, __from: from };
    };
    const result = opts.q ? await run(opts.q) : await this.db.tx(run);
    if (result.__from && result.__from !== result.state) {
      this.realtime.publish(eventId, 'public', { type: 'event.state', state: result.state === 'suspended' || result.state === 'deleted' ? result.state : result.state });
      this.realtime.publish(eventId, 'staff', { type: 'event.state', state: result.state });
      if (to === 'deletion_pending') {
        void this.notify.queueTransactional({ userId: result.owner_id, template: 'deletion_scheduled', locale: result.language, eventId, params: { event: result.name, date: new Date(result.deletion_deadline).toISOString().slice(0, 10) } }).catch(() => undefined);
      }
    }
    return result;
  }

  /** Restores from suspension / cancelled deletion to the state the clock says the event should be in. */
  async restoreState(eventId: string, opts: TransitionOpts): Promise<any> {
    const ev = await this.db.one<any>('SELECT * FROM events WHERE id = $1', [eventId]);
    if (!ev) throw E.notFound('event_not_found');
    const prev = (ev.prev_state as EventState | null) ?? 'draft';
    const target: EventState = prev === 'draft' ? 'draft' : prev === 'archived' || prev === 'read_only' ? prev : stateFromClock(new Date(), ev);
    return this.transition(eventId, target, opts);
  }

  // ---------------------------------------------------------------- scheduler tick
  /** Idempotent clock-driven progression. Safe to run on multiple workers (row locks + guarded UPDATEs). */
  async tick(now = new Date()): Promise<Record<string, number>> {
    const out: Record<string, number> = { opened: 0, closing: 0, read_only: 0, archived: 0, deletion_pending: 0, reminders: 0 };

    for (const r of await this.db.many<{ id: string }>(`SELECT id FROM events WHERE state = 'scheduled' AND upload_opens_at <= $1 LIMIT 200`, [now])) {
      await this.safe(() => this.transition(r.id, 'live', { trigger: 'schedule', reason: 'upload window opened' })); out.opened++;
    }
    for (const r of await this.db.many<{ id: string }>(`SELECT id FROM events WHERE state = 'live' AND upload_closes_at <= $1 LIMIT 200`, [now])) {
      await this.safe(() => this.transition(r.id, 'closing', { trigger: 'schedule', reason: 'upload window ended' })); out.closing++;
    }
    // closing -> read_only once queued work has drained (or the closing grace elapsed)
    const closing = await this.db.many<{ id: string }>(
      `SELECT e.id FROM events e WHERE e.state = 'closing' AND (
          e.closed_at < $1::timestamptz - ($2 || ' minutes')::interval
          OR NOT EXISTS (SELECT 1 FROM media m WHERE m.event_id = e.id AND m.deleted_at IS NULL
                           AND (m.upload_state IN ('uploaded','processing')
                                OR (m.upload_state IN ('intent','uploading') AND m.created_at > $1::timestamptz - interval '10 minutes')))
        ) LIMIT 200`, [now, String(this.cfg.CLOSING_MAX_MINUTES)]);
    for (const r of closing) { await this.safe(() => this.transition(r.id, 'read_only', { trigger: 'schedule', reason: 'uploads drained; gallery read-only' })); out.read_only++; }

    const days = await this.settings.get<number>('retention.readonly_to_archive_days', this.cfg.READONLY_TO_ARCHIVE_DAYS);
    for (const r of await this.db.many<{ id: string }>(
      `SELECT id FROM events WHERE state = 'read_only' AND read_only_at <= $1::timestamptz - ($2 || ' days')::interval AND (retention_until IS NULL OR retention_until > $1) LIMIT 200`, [now, String(days)])) {
      await this.safe(() => this.transition(r.id, 'archived', { trigger: 'schedule', reason: 'automatic archive' })); out.archived++;
    }
    // retention expiry => deletion lifecycle (blocked by legal hold)
    for (const r of await this.db.many<{ id: string }>(
      `SELECT id FROM events WHERE state IN ('read_only','archived') AND retention_until IS NOT NULL AND retention_until <= $1 AND legal_hold = false LIMIT 200`, [now])) {
      await this.safe(() => this.transition(r.id, 'deletion_pending', { trigger: 'retention', reason: 'retention period ended', deletionTrigger: 'retention_expiry' })); out.deletion_pending++;
    }
    // heads-up SMS to owners 24 h before uploads close (once per event)
    for (const r of await this.db.many<any>(
      `SELECT e.id, e.owner_id, e.name, e.language FROM events e
        WHERE e.state = 'live' AND e.upload_closes_at BETWEEN $1 AND $1::timestamptz + interval '24 hours'
          AND NOT EXISTS (SELECT 1 FROM notifications n WHERE n.event_id = e.id AND n.template = 'event_closing_soon') LIMIT 100`, [now])) {
      await this.safe(() => this.notify.queueTransactional({ userId: r.owner_id, template: 'event_closing_soon', locale: r.language, eventId: r.id, params: { event: r.name } })); out.reminders++;
    }
    return out;
  }

  private async safe(fn: () => Promise<unknown>): Promise<void> {
    try { await fn(); } catch (e) { this.log.warn(`lifecycle step skipped: ${(e as Error).message}`); }
  }
}
