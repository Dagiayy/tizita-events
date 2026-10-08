import { Inject, Injectable, Logger } from '@nestjs/common';
import archiver from 'archiver';
import type { Response } from 'express';
import { PassThrough } from 'stream';
import { z } from 'zod';
import { AnalyticsService } from '../analytics/analytics.service';
import { AuditService } from '../audit/audit.service';
import { AppConfig, CONFIG } from '../common/config';
import { E } from '../common/errors';
import { Principal } from '../common/request-context';
import { AccessService } from '../events/access.service';
import { EntitlementsService } from '../events/entitlements.service';
import { assertAllowed } from '../events/lifecycle';
import { Db } from '../infra/db.service';
import { IdempotencyService } from '../infra/idempotency.service';
import { QUEUES, QueueService } from '../infra/queue.service';
import { StorageService, keys } from '../infra/storage.service';
import { SignedUrlService } from '../media/signed-url.service';

export const ExportSchema = z.object({
  scope: z.enum(['full', 'folder', 'selected']),
  folder_id: z.string().uuid().optional(),
  media_ids: z.array(z.string().uuid()).min(1).max(1000).optional(),
  variant: z.enum(['optimized', 'original']).default('optimized'),
}).strict();

const EXPORT_TTL_DAYS = 7;
const safeName = (s: string) => s.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim().slice(0, 60) || 'photos';

@Injectable()
export class ExportsService {
  private readonly log = new Logger('Exports');
  constructor(
    private readonly db: Db, private readonly access: AccessService, private readonly ents: EntitlementsService, private readonly queues: QueueService,
    private readonly idem: IdempotencyService, private readonly audit: AuditService, private readonly storage: StorageService, private readonly signer: SignedUrlService,
    private readonly analytics: AnalyticsService, @Inject(CONFIG) private readonly cfg: AppConfig,
  ) {}

  /** Asynchronous export. Original quality needs both the plan entitlement and stored originals. */
  async create(me: Principal, eventId: string, raw: unknown, idemKey?: string) {
    const body = ExportSchema.parse(raw);
    const { event, userId } = await this.access.requireMember(me, eventId, 'event.export');
    assertAllowed(event.state, 'export');
    if (body.scope === 'folder' && !body.folder_id) throw E.badRequest('folder_required');
    if (body.scope === 'selected' && !body.media_ids?.length) throw E.badRequest('media_ids_required');
    if (body.variant === 'original') {
      const ent = await this.ents.effective(eventId);
      if (!ent.allow_original_export || !ent.original_storage) throw E.forbidden('plan_feature_unavailable', 'Original-quality export is not included in this package.');
    }
    return this.idem.run(`export:${userId}`, idemKey, { eventId, body }, async () => {
      const active = await this.db.one<any>(`SELECT * FROM exports WHERE event_id = $1 AND state IN ('queued','processing') AND scope = $2 AND variant = $3 AND folder_id IS NOT DISTINCT FROM $4 ORDER BY created_at DESC LIMIT 1`,
        [eventId, body.scope, body.variant, body.folder_id ?? null]);
      if (active && body.scope !== 'selected') return this.dto(active);
      const row = await this.db.one<any>(
        `INSERT INTO exports (event_id, requested_by, scope, folder_id, media_ids, variant, idempotency_key) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [eventId, userId, body.scope, body.folder_id ?? null, body.media_ids ?? null, body.variant, idemKey ?? null]);
      await this.queues.add(QUEUES.exports, 'build', { exportId: row.id }, { jobId: `export-${row.id}` });
      await this.audit.record({ action: 'export.requested', resourceType: 'export', resourceId: row.id, eventId, after: { scope: body.scope, variant: body.variant } });
      return this.dto(row);
    });
  }

  dto(r: any) {
    return { id: r.id, event_id: r.event_id, scope: r.scope, variant: r.variant, state: r.state, item_count: r.item_count, bytes: r.bytes === null ? null : Number(r.bytes), expires_at: r.expires_at, created_at: r.created_at, completed_at: r.completed_at, error: r.state === 'failed' ? 'export_failed' : undefined };
  }

  async status(me: Principal, exportId: string) {
    const r = await this.db.one<any>('SELECT * FROM exports WHERE id = $1', [exportId]);
    if (!r) throw E.notFound('export_not_found');
    await this.access.requireMember(me, r.event_id, 'event.export');
    return this.dto(r);
  }

  async listForEvent(me: Principal, eventId: string) {
    await this.access.requireMember(me, eventId, 'event.export');
    return { exports: (await this.db.many<any>('SELECT * FROM exports WHERE event_id = $1 ORDER BY created_at DESC LIMIT 50', [eventId])).map((r) => this.dto(r)) };
  }

  /** Issues a time-limited signed link. The file itself is streamed by the API; the bucket is never exposed. */
  async downloadLink(me: Principal, exportId: string) {
    const r = await this.db.one<any>('SELECT * FROM exports WHERE id = $1', [exportId]);
    if (!r) throw E.notFound('export_not_found');
    const { event } = await this.access.requireMember(me, r.event_id, 'event.export');
    assertAllowed(event.state, 'export');
    if (r.state !== 'ready') throw E.conflict('export_not_ready', 'The export is not ready yet.', { state: r.state });
    if (new Date(r.expires_at) < new Date()) throw E.gone('export_expired', 'This export has expired. Create a new one.');
    await this.audit.record({ action: 'export.download_link_issued', resourceType: 'export', resourceId: exportId, eventId: r.event_id });
    return this.signer.exportUrl(exportId);
  }

  async streamFile(exportId: string, exp: string | undefined, sig: string | undefined, res: Response) {
    this.signer.verifyExport(exportId, exp, sig);
    const r = await this.db.one<any>(`SELECT x.*, e.state AS event_state FROM exports x JOIN events e ON e.id = x.event_id WHERE x.id = $1`, [exportId]);
    if (!r || r.state !== 'ready' || !r.object_key || new Date(r.expires_at) < new Date() || ['deleted', 'suspended'].includes(r.event_state)) throw E.notFound('export_not_found');
    const { stream, size } = await this.storage.getStream('exports', r.object_key);
    res.setHeader('Content-Type', 'application/zip');
    if (size) res.setHeader('Content-Length', String(size));
    res.setHeader('Content-Disposition', `attachment; filename="event-album-${exportId.slice(0, 8)}.zip"`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    this.analytics.inc(r.event_id, 'export_download');
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  }

  // ------------------------------------------------------------------ worker
  async build(exportId: string): Promise<void> {
    const x = await this.db.one<any>(`UPDATE exports SET state = 'processing' WHERE id = $1 AND state IN ('queued','processing') RETURNING *`, [exportId]);
    if (!x) return;
    try {
      let where = `m.event_id = $1 AND m.deleted_at IS NULL AND m.upload_state = 'ready'`;
      const params: unknown[] = [x.event_id, x.variant === 'original' ? 'original' : 'viewer'];
      if (x.scope === 'full') where += ` AND m.moderation_state = 'approved'`;
      if (x.scope === 'folder') { params.push(x.folder_id); where += ` AND m.moderation_state = 'approved' AND m.folder_id = $${params.length}`; }
      if (x.scope === 'selected') { params.push(x.media_ids); where += ` AND m.id = ANY($${params.length}::uuid[]) AND m.moderation_state <> 'rejected'`; }
      const items = await this.db.many<any>(
        `SELECT m.id, m.captured_at, m.published_at, m.created_at, f.name AS folder_name, d.object_key, d.mime FROM media m
           JOIN media_derivatives d ON d.media_id = m.id AND d.variant = $2 LEFT JOIN event_folders f ON f.id = m.folder_id WHERE ${where} ORDER BY COALESCE(m.captured_at, m.created_at), m.id`, params);
      if (!items.length) throw new Error('nothing to export');

      const key = keys.export(x.event_id, x.id);
      const out = new PassThrough();
      const zip = archiver('zip', { zlib: { level: 0 }, forceZip64: false }); // JPEG data does not compress; store only
      zip.on('error', (e) => out.destroy(e));
      zip.pipe(out);
      const upload = this.storage.putStream('exports', key, out, 'application/zip');
      let n = 0;
      for (const it of items) {
        const buf = await this.storage.getBuffer('media', it.object_key); // one photo in memory at a time (<= 15 MB)
        const d = new Date(it.captured_at ?? it.created_at);
        const ext = it.mime === 'image/png' ? 'png' : it.mime === 'image/webp' ? 'webp' : it.mime?.includes('hei') ? 'heic' : 'jpg';
        // names are generated; the client filename and embedded metadata are never reused
        const entryDone = new Promise<void>((resolve) => zip.once('entry', () => resolve())); // simple backpressure
        zip.append(buf, { name: `${safeName(it.folder_name ?? 'photos')}/photo-${String(++n).padStart(5, '0')}-${d.toISOString().slice(0, 10)}.${ext}` });
        await entryDone;
      }
      await zip.finalize();
      await upload;
      const head = await this.storage.head('exports', key);
      await this.db.query(`UPDATE exports SET state = 'ready', object_key = $2, bytes = $3, item_count = $4, completed_at = now(), expires_at = now() + ($5 || ' days')::interval, error = NULL WHERE id = $1`,
        [x.id, key, head?.size ?? 0, items.length, String(EXPORT_TTL_DAYS)]);
      await this.audit.record({ action: 'export.completed', resourceType: 'export', resourceId: x.id, eventId: x.event_id, actor: { type: 'system' }, after: { items: items.length, bytes: head?.size ?? 0 } });
    } catch (e) {
      this.log.warn(`export ${exportId} failed: ${(e as Error).message}`);
      await this.db.query(`UPDATE exports SET state = 'failed', error = $2 WHERE id = $1`, [exportId, (e as Error).message.slice(0, 200)]);
      throw e;
    }
  }

  async expireOld(): Promise<number> {
    const rows = await this.db.many<any>(`UPDATE exports SET state = 'expired' WHERE state = 'ready' AND expires_at < now() RETURNING id, event_id, object_key`);
    for (const r of rows) if (r.object_key) await this.storage.delete('exports', r.object_key).catch(() => undefined);
    return rows.length;
  }
}
