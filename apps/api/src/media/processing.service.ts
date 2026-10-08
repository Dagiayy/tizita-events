import { Inject, Injectable, Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import { AnalyticsService } from '../analytics/analytics.service';
import { AuditService } from '../audit/audit.service';
import { AppConfig, CONFIG } from '../common/config';
import { EntitlementsService } from '../events/entitlements.service';
import { RealtimeService } from '../gallery/realtime.service';
import { Db } from '../infra/db.service';
import { MetricsService } from '../infra/metrics.service';
import { SettingsService } from '../infra/settings.service';
import { StorageService, keys } from '../infra/storage.service';
import { ImageService, MediaRejected, sniffMime } from './image.service';
import { ScanService } from './scan.service';
import { SignedUrlService } from './signed-url.service';

const MAX_ATTEMPTS = 5;

/**
 * The asynchronous media pipeline (spec 8.1):
 *  quarantine -> size check -> magic-byte/MIME validation -> malware scan -> decode safety -> metadata -> exact hash ->
 *  duplicate check -> perceptual hash -> EXIF-stripped derivatives -> (protected original if entitled) ->
 *  moderation state assignment -> publication -> realtime event -> quarantine cleanup.
 * Deterministic rejections fail immediately and permanently; infrastructure errors are retried with backoff.
 */
@Injectable()
export class ProcessingService {
  private readonly log = new Logger('MediaProcessing');
  constructor(
    private readonly db: Db,
    private readonly storage: StorageService,
    private readonly images: ImageService,
    private readonly scanner: ScanService,
    private readonly ents: EntitlementsService,
    private readonly realtime: RealtimeService,
    private readonly signer: SignedUrlService,
    private readonly analytics: AnalyticsService,
    private readonly audit: AuditService,
    private readonly metrics: MetricsService,
    private readonly settings: SettingsService,
    @Inject(CONFIG) private readonly cfg: AppConfig,
  ) {}

  async process(mediaId: string, attempt = 1, finalAttempt = false): Promise<void> {
    const timer = this.metrics.mediaProcessSeconds.startTimer();
    const claimed = await this.db.one<any>(
      `UPDATE media SET upload_state = 'processing', processing_attempts = processing_attempts + 1
        WHERE id = $1 AND upload_state IN ('uploaded','processing') RETURNING *`, [mediaId]);
    if (!claimed) return; // already handled (idempotent job)
    const m = claimed;
    try {
      const ev = await this.db.one<any>('SELECT * FROM events WHERE id = $1', [m.event_id]);
      if (!ev || ['deleted', 'deletion_pending'].includes(ev.state)) { await this.fail(m, 'event_unavailable', 'event no longer accepting media'); return; }

      // 1. assemble from quarantine
      const parts = await this.db.many<{ part_no: number }>('SELECT part_no FROM upload_parts WHERE media_id = $1 ORDER BY part_no', [m.id]);
      const bufs: Buffer[] = [];
      for (const p of parts) bufs.push(await this.storage.getBuffer('quarantine', keys.quarantinePart(m.event_id, m.id, p.part_no)));
      const original = Buffer.concat(bufs);
      const maxBytes = await this.settings.get<number>('media.max_bytes', this.cfg.MEDIA_MAX_BYTES);
      if (original.length !== Number(m.declared_size) || original.length > maxBytes) throw new MediaRejected('size_mismatch', 'assembled size invalid');

      // 2. magic bytes (client MIME/filename never trusted)
      const detected = sniffMime(original);
      const allowed = await this.settings.get<string[]>('media.allowed_mime', this.cfg.MEDIA_ALLOWED_MIME.split(','));
      if (!detected) throw new MediaRejected('invalid_magic', 'file signature is not a supported image');
      if (!allowed.includes(detected)) throw new MediaRejected('type_not_allowed', `detected ${detected}`);

      // 3. malware scan (fail-closed)
      const scan = await this.scanner.scan(original);
      if (!scan.clean) {
        await this.audit.record({ action: 'media.malware_detected', resourceType: 'media', resourceId: m.id, eventId: m.event_id, actor: { type: 'system' }, after: { signature: scan.signature } });
        throw new MediaRejected('malware_detected', scan.signature);
      }

      // 4. decode safety + metadata
      const { working } = await this.images.normalizeInput(original, detected);
      const facts = await this.images.inspect(working);

      // 5. exact hash + duplicate check
      const sha256 = createHash('sha256').update(original).digest('hex');
      const dup = await this.db.one<{ id: string }>(
        `SELECT id FROM media WHERE event_id = $1 AND sha256 = $2 AND upload_state = 'ready' AND deleted_at IS NULL AND id <> $3 LIMIT 1`, [m.event_id, sha256, m.id]);
      if (dup) {
        await this.db.query(`UPDATE media SET upload_state = 'duplicate', dup_of_media_id = $2, sha256 = NULL, mime = $3, size_bytes = $4, processed_at = now() WHERE id = $1`, [m.id, dup.id, detected, original.length]);
        await this.cleanupQuarantine(m);
        this.metrics.mediaProcessed.inc({ outcome: 'duplicate' });
        timer();
        return;
      }

      // 6. perceptual hash: near-duplicates are flagged for the host but never blocked
      const phash = await this.images.perceptualHash(working);
      const near = await this.db.one<{ id: string }>(
        `SELECT id FROM media WHERE event_id = $1 AND upload_state = 'ready' AND deleted_at IS NULL AND phash IS NOT NULL AND bit_count(((phash # $2::bigint))::bit(64)) <= 5 ORDER BY published_at DESC NULLS LAST LIMIT 1`,
        [m.event_id, phash]);

      // 7. derivatives (metadata stripped) + optional protected original
      const ent = await this.ents.effective(m.event_id);
      const folder = m.folder_id ? await this.db.one<any>('SELECT watermark, publication_state FROM event_folders WHERE id = $1', [m.folder_id]) : null;
      const wm = (ev.watermark_enabled || folder?.watermark) && ent.watermark ? (ev.host_name || ev.name) : null;
      const derivs = await this.images.derivatives(working, { watermarkText: wm });
      let stored = 0;
      const rows: { variant: string; key: string; mime: string; w: number | null; h: number | null; bytes: number; sum: string }[] = [];
      for (const d of derivs) {
        const key = keys.derivative(m.event_id, m.id, d.variant);
        await this.storage.put('media', key, d.buffer, 'image/jpeg');
        stored += d.buffer.length;
        rows.push({ variant: d.variant, key, mime: 'image/jpeg', w: d.width, h: d.height, bytes: d.buffer.length, sum: createHash('sha256').update(d.buffer).digest('hex') });
      }
      let originalKey: string | null = null;
      if (ent.original_storage) {
        originalKey = keys.original(m.event_id, m.id);
        await this.storage.put('media', originalKey, original, detected);
        stored += original.length;
        rows.push({ variant: 'original', key: originalKey, mime: detected, w: facts.width, h: facts.height, bytes: original.length, sum: sha256 });
      }

      // 8. moderation state assignment
      const trusted = !!m.uploader_user_id; // host / moderator / photographer
      const moderation = (trusted || ev.moderation_mode === 'post') && !m.caption_flagged ? 'approved' : 'pending';   // keyword-flagged captions are always held for review

      await this.db.tx(async (c) => {
        for (const r of rows) {
          await c.query(
            `INSERT INTO media_derivatives (media_id, variant, object_key, mime, width, height, byte_size, checksum) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
             ON CONFLICT (media_id, variant) DO UPDATE SET object_key = EXCLUDED.object_key, byte_size = EXCLUDED.byte_size, checksum = EXCLUDED.checksum`,
            [m.id, r.variant, r.key, r.mime, r.w, r.h, r.bytes, r.sum]);
        }
        await c.query(
          `UPDATE media SET upload_state = 'ready', moderation_state = $2, mime = $3, size_bytes = $4, stored_bytes = $5, width = $6, height = $7, orientation = $8, captured_at = $9,
                  sha256 = $10, phash = $11::bigint, near_dup_of_media_id = $12, original_key = $13, processed_at = now(), published_at = CASE WHEN $2 = 'approved' THEN now() END,
                  failure_code = NULL, failure_detail = NULL
            WHERE id = $1`,
          [m.id, moderation, detected, original.length, stored, facts.width, facts.height, facts.orientation, facts.capturedAt, sha256, phash, near?.id ?? null, originalKey]);
        await c.query('UPDATE events SET storage_bytes = storage_bytes + $2, media_count = media_count + 1, updated_at = now() WHERE id = $1', [m.event_id, stored]);
        await c.query(`INSERT INTO moderation_logs (event_id, media_id, actor_type, action, from_state, to_state, reason) VALUES ($1,$2,'system','auto_assign','pending',$3,$4)`,
          [m.event_id, m.id, moderation, m.caption_flagged ? 'caption matched keyword rules' : trusted ? 'trusted uploader' : `moderation_mode=${ev.moderation_mode}`]);
      });

      // 9. publication + realtime
      await this.cleanupQuarantine(m);
      this.analytics.inc(m.event_id, 'processed');
      if (moderation === 'approved') this.analytics.inc(m.event_id, 'approved');
      this.announce(ev, m.id, moderation, folder, facts);
      await this.quotaAlerts(m.event_id);
      this.metrics.mediaProcessed.inc({ outcome: 'ready' });
      timer();
    } catch (e) {
      timer();
      if (e instanceof MediaRejected) { await this.fail(m, e.code, e.message); return; }
      this.log.warn(`media ${mediaId} attempt ${attempt} failed: ${(e as Error).message}`);
      if (finalAttempt || m.processing_attempts >= MAX_ATTEMPTS) { await this.fail(m, 'processing_error', (e as Error).message.slice(0, 200)); return; }
      await this.db.query(`UPDATE media SET upload_state = 'uploaded' WHERE id = $1 AND upload_state = 'processing'`, [mediaId]);
      throw e; // BullMQ retries with exponential backoff
    }
  }

  private async fail(m: any, code: string, detail: string): Promise<void> {
    await this.db.query(`UPDATE media SET upload_state = 'failed', failure_code = $2, failure_detail = $3, processed_at = now() WHERE id = $1`, [m.id, code, detail.slice(0, 300)]);
    await this.cleanupQuarantine(m);
    this.analytics.inc(m.event_id, 'upload_failed');
    this.metrics.mediaProcessed.inc({ outcome: code });
    await this.db.query(`INSERT INTO moderation_logs (event_id, media_id, actor_type, action, reason) VALUES ($1,$2,'system','processing_rejected',$3)`, [m.event_id, m.id, code]);
  }

  private async cleanupQuarantine(m: any): Promise<void> {
    await this.storage.deletePrefix('quarantine', keys.quarantinePrefix(m.event_id, m.id)).catch(() => undefined);
    await this.db.query('DELETE FROM upload_parts WHERE media_id = $1', [m.id]).catch(() => undefined);
  }

  /** Public channel only ever receives approved media; the staff channel receives every state. */
  announce(ev: any, mediaId: string, moderation: string, folder: any, facts: { width: number; height: number }): void {
    const staff = { type: 'media.updated', media_id: mediaId, moderation_state: moderation, upload_state: 'ready' };
    this.realtime.publish(ev.id, 'staff', staff);
    if (moderation === 'approved' && (!folder || folder.publication_state === 'published')) {
      this.realtime.publish(ev.id, 'public', {
        type: 'media.published', media: { id: mediaId, width: facts.width, height: facts.height, published_at: new Date().toISOString(), urls: this.publicUrls(mediaId) },
      });
    }
  }

  publicUrls(mediaId: string) {
    return { thumb: this.signer.mediaUrl(mediaId, 'thumb', 'pub'), gallery: this.signer.mediaUrl(mediaId, 'gallery', 'pub'), viewer: this.signer.mediaUrl(mediaId, 'viewer', 'pub') };
  }

  /** Storage quota alerts at 70/85/95/100 % (spec 16): audited once per level. */
  private async quotaAlerts(eventId: string): Promise<void> {
    const u = await this.ents.usage(eventId);
    const levels = await this.settings.get<number[]>('quota.alert_thresholds', [70, 85, 95, 100]);
    const level = [...levels].sort((a, b) => b - a).find((t) => u.percent >= t);
    if (!level) return;
    const seen = await this.db.one('SELECT 1 FROM audit_events WHERE action = \'quota.alert\' AND event_id = $1 AND (after_summary->>\'level\')::int = $2', [eventId, level]);
    if (!seen) await this.audit.record({ action: 'quota.alert', resourceType: 'event', resourceId: eventId, eventId, actor: { type: 'system' }, after: { level, percent: u.percent } });
  }
}
