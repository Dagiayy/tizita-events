import { Inject, Injectable, Logger } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { AppConfig, CONFIG } from '../common/config';
import { E } from '../common/errors';
import { LifecycleService } from '../events/lifecycle.service';
import { Db } from '../infra/db.service';
import { StorageService, keys } from '../infra/storage.service';

/**
 * Retention enforcement and permanent purge (spec 7, 13, 22).
 * Purge removes event media, derivatives, exports, guest sessions and event content from the live system and keeps only
 * legally required records: payments/invoices, consent evidence, audit events and the deletion evidence itself.
 * Backups are not rewritten: they expire on the backup lifecycle (backup_purge_by is recorded) - legal validation pending.
 */
@Injectable()
export class DeletionService {
  private readonly log = new Logger('Deletion');
  constructor(
    private readonly db: Db, private readonly storage: StorageService, private readonly audit: AuditService, private readonly lifecycle: LifecycleService,
    @Inject(CONFIG) private readonly cfg: AppConfig,
  ) {}

  /** Picks up due jobs; legal-hold events are parked as 'held' and re-evaluated on release. */
  async runDue(limit = 20): Promise<{ completed: number; held: number; failed: number }> {
    const out = { completed: 0, held: 0, failed: 0 };
    const jobs = await this.db.many<any>(`SELECT j.*, e.legal_hold AS event_hold FROM deletion_jobs j LEFT JOIN events e ON e.id = j.event_id
        WHERE j.status IN ('pending','held') AND j.scheduled_at <= now() ORDER BY j.scheduled_at LIMIT $1`, [limit]);
    for (const j of jobs) {
      if (j.legal_hold || j.event_hold) {
        if (j.status !== 'held') await this.db.query(`UPDATE deletion_jobs SET status = 'held', legal_hold = true WHERE id = $1`, [j.id]);
        out.held++; continue;
      }
      try { await this.run(j.id); out.completed++; } catch (e) {
        out.failed++; this.log.error(`deletion job ${j.id} failed: ${(e as Error).message}`);
      }
    }
    return out;
  }

  async run(jobId: string): Promise<any> {
    const job = await this.db.one<any>(
      `UPDATE deletion_jobs SET status = 'running', started_at = COALESCE(started_at, now()), attempts = attempts + 1 WHERE id = $1 AND status IN ('pending','held','running','failed') RETURNING *`, [jobId]);
    if (!job) throw E.conflict('job_not_runnable');
    try {
      let evidence: Record<string, unknown>;
      if (job.resource_type === 'event') evidence = await this.purgeEvent(job.resource_id);
      else if (job.resource_type === 'media') evidence = await this.purgeMedia(job.resource_id);
      else if (job.resource_type === 'guest_session') evidence = await this.purgeGuestSession(job.resource_id);
      else evidence = await this.anonymizeUser(job.resource_id);
      await this.db.query(`UPDATE deletion_jobs SET status = 'completed', completed_at = now(), evidence = $2::jsonb, last_error = NULL WHERE id = $1`, [jobId, JSON.stringify(evidence)]);
      await this.audit.record({ action: 'deletion.completed', resourceType: job.resource_type, resourceId: job.resource_id, eventId: job.event_id, actor: { type: 'system' }, after: evidence });
      return evidence;
    } catch (e) {
      await this.db.query(`UPDATE deletion_jobs SET status = 'failed', last_error = $2 WHERE id = $1`, [jobId, (e as Error).message.slice(0, 300)]);
      throw e;
    }
  }

  async purgeEvent(eventId: string): Promise<Record<string, unknown>> {
    const ev = await this.db.one<any>('SELECT * FROM events WHERE id = $1', [eventId]);
    if (!ev) throw E.notFound('event_not_found');
    if (ev.legal_hold) throw E.conflict('legal_hold', 'Event is under legal hold');
    if (ev.state !== 'deletion_pending') throw E.conflict('not_pending_deletion');
    const a = await this.storage.deletePrefix('media', keys.eventMediaPrefix(eventId));
    const b = await this.storage.deletePrefix('quarantine', `q/${eventId}/`);
    const c = await this.storage.deletePrefix('exports', `x/${eventId}/`);
    // verify nothing remains (evidence of completion)
    let remaining = 0;
    for (const [bucket, prefix] of [['media', keys.eventMediaPrefix(eventId)], ['quarantine', `q/${eventId}/`], ['exports', `x/${eventId}/`]] as const) {
      for await (const _o of this.storage.list(bucket, prefix)) { remaining++; break; }
    }
    if (remaining) throw new Error('objects remain after purge');
    const counts = await this.db.tx(async (q) => {
      const media = (await q.query('DELETE FROM media WHERE event_id = $1', [eventId])).rowCount;
      const sessions = (await q.query('DELETE FROM guest_sessions WHERE event_id = $1', [eventId])).rowCount;
      await q.query('DELETE FROM access_secrets WHERE event_id = $1', [eventId]);
      await q.query('DELETE FROM event_folders WHERE event_id = $1', [eventId]);
      await q.query('DELETE FROM event_members WHERE event_id = $1', [eventId]);
      await q.query('DELETE FROM blocked_devices WHERE event_id = $1', [eventId]);
      await q.query('DELETE FROM analytics_counters WHERE event_id = $1', [eventId]);
      await q.query('DELETE FROM exports WHERE event_id = $1', [eventId]);
      await q.query('DELETE FROM moderation_logs WHERE event_id = $1', [eventId]);
      await q.query('UPDATE notifications SET params = \'{}\'::jsonb WHERE event_id = $1', [eventId]);
      // tombstone: keep identifiers needed for payments/audit, scrub personal/content fields
      await q.query(`UPDATE events SET name = '[deleted]', venue = NULL, host_name = NULL, region = NULL, cover_object_key = NULL, brand_color = NULL, storage_bytes = 0, media_count = 0, updated_at = now() WHERE id = $1`, [eventId]);
      return { media_rows: media, guest_sessions: sessions };
    });
    await this.lifecycle.transition(eventId, 'deleted', { trigger: 'system', reason: 'purge completed' });
    return { objects_deleted: a.objects + b.objects + c.objects, bytes_deleted: a.bytes + b.bytes + c.bytes, ...counts, objects_remaining: 0,
      retained_records: ['payment_orders', 'invoices', 'entitlements', 'consent_records', 'audit_events', 'deletion_jobs'], backup_expiry_days: this.cfg.BACKUP_RETENTION_DAYS };
  }

  async purgeMedia(mediaId: string): Promise<Record<string, unknown>> {
    const m = await this.db.one<any>('SELECT * FROM media WHERE id = $1', [mediaId]);
    if (!m) return { already_deleted: true };
    const a = await this.storage.deletePrefix('media', `e/${m.event_id}/m/${m.id}/`);
    const b = await this.storage.deletePrefix('quarantine', keys.quarantinePrefix(m.event_id, m.id));
    await this.db.tx(async (q) => {
      await q.query('UPDATE events SET storage_bytes = GREATEST(0, storage_bytes - $2), media_count = GREATEST(0, media_count - CASE WHEN $3 THEN 1 ELSE 0 END) WHERE id = $1', [m.event_id, m.stored_bytes, m.upload_state === 'ready' && !m.deleted_at]);
      await q.query('DELETE FROM media WHERE id = $1', [mediaId]);
    });
    return { objects_deleted: a.objects + b.objects, bytes_deleted: a.bytes + b.bytes };
  }

  async purgeGuestSession(sessionId: string): Promise<Record<string, unknown>> {
    const rows = await this.db.many<{ id: string }>('SELECT id FROM media WHERE uploader_session_id = $1', [sessionId]);
    let objects = 0;
    for (const r of rows) objects += ((await this.purgeMedia(r.id)).objects_deleted as number) ?? 0;
    await this.db.query('DELETE FROM guest_sessions WHERE id = $1', [sessionId]);
    return { media_deleted: rows.length, objects_deleted: objects };
  }

  /** Account erasure: identifiers are removed; payment records stay (financial record keeping) without direct identifiers. */
  async anonymizeUser(userId: string): Promise<Record<string, unknown>> {
    const owned = await this.db.one<{ n: number }>(`SELECT count(*)::int AS n FROM events WHERE owner_id = $1 AND state NOT IN ('deleted')`, [userId]);
    if (owned && owned.n > 0) throw E.conflict('user_owns_events', 'Delete or transfer the account\'s events before erasing the account.');
    await this.db.tx(async (q) => {
      await q.query(`UPDATE sessions SET revoked_at = now(), revoke_reason = 'account_erased' WHERE user_id = $1 AND revoked_at IS NULL`, [userId]);
      await q.query(`UPDATE users SET status = 'deleted', display_name = NULL, phone_enc = 'erased', phone_last4 = '----', phone_hash = 'erased:' || id::text, totp_secret_enc = NULL, totp_enabled = false WHERE id = $1`, [userId]);
      await q.query(`UPDATE event_members SET status = 'removed' WHERE user_id = $1`, [userId]);
    });
    return { user_anonymized: true };
  }

  async cancelForEvent(eventId: string): Promise<void> {
    await this.db.query(`UPDATE deletion_jobs SET status = 'cancelled' WHERE resource_type = 'event' AND resource_id = $1 AND status IN ('pending','held')`, [eventId]);
  }

  /** Legal hold: parks deletion and blocks retention-driven deletion until released (audited by caller). */
  async placeHold(staffId: string, eventId: string, reason: string) {
    return this.db.tx(async (q) => {
      const ev = (await q.query<any>('SELECT id FROM events WHERE id = $1 FOR UPDATE', [eventId])).rows[0];
      if (!ev) throw E.notFound('event_not_found');
      await q.query('INSERT INTO legal_holds (event_id, reason, placed_by) VALUES ($1,$2,$3)', [eventId, reason, staffId]);
      await q.query('UPDATE events SET legal_hold = true WHERE id = $1', [eventId]);
      await q.query(`UPDATE deletion_jobs SET status = 'held', legal_hold = true WHERE event_id = $1 AND status = 'pending'`, [eventId]);
      await this.audit.record({ action: 'legal_hold.placed', resourceType: 'event', resourceId: eventId, eventId, reason }, q);
      return { ok: true };
    });
  }
  async releaseHold(staffId: string, eventId: string, reason: string) {
    return this.db.tx(async (q) => {
      await q.query('UPDATE legal_holds SET released_at = now(), released_by = $2 WHERE event_id = $1 AND released_at IS NULL', [eventId, staffId]);
      await q.query('UPDATE events SET legal_hold = false WHERE id = $1', [eventId]);
      await q.query(`UPDATE deletion_jobs SET status = 'pending', legal_hold = false WHERE event_id = $1 AND status = 'held'`, [eventId]);
      await this.audit.record({ action: 'legal_hold.released', resourceType: 'event', resourceId: eventId, eventId, reason }, q);
      return { ok: true };
    });
  }
}
