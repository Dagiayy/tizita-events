import { Inject, Injectable } from '@nestjs/common';
import { createHash } from 'crypto';
import { z } from 'zod';
import { AnalyticsService } from '../analytics/analytics.service';
import { AuditService } from '../audit/audit.service';
import { AppConfig, CONFIG } from '../common/config';
import { E } from '../common/errors';
import { Principal } from '../common/request-context';
import { AccessService } from '../events/access.service';
import { EntitlementsService } from '../events/entitlements.service';
import { assertAllowed, stateAllows } from '../events/lifecycle';
import { Db } from '../infra/db.service';
import { IdempotencyService } from '../infra/idempotency.service';
import { MetricsService } from '../infra/metrics.service';
import { QUEUES, QueueService } from '../infra/queue.service';
import { RedisService } from '../infra/redis.service';
import { SettingsService } from '../infra/settings.service';
import { StorageService, keys } from '../infra/storage.service';
import { SignedUrlService } from './signed-url.service';

export const IntentSchema = z.object({
  mime: z.string().max(100),
  size: z.number().int().positive(),
  caption: z.string().max(1000).optional(),
  folder_id: z.string().uuid().optional(),
  client_filename: z.string().max(200).optional(), // accepted for UX only; NEVER used for object keys
}).strict();

/** Case/width-insensitive substring match (NFKC); works for Latin and Ethiopic keywords. */
export function captionMatches(caption: string, words: string[]): boolean {
  const norm = (x: string) => x.normalize('NFKC').toLowerCase();
  const c = norm(caption);
  return words.some((w) => w.trim() && c.includes(norm(w.trim())));
}

type Uploader = { kind: 'guest'; sessionId: string } | { kind: 'user'; userId: string };

@Injectable()
export class UploadService {
  constructor(
    private readonly db: Db,
    private readonly redis: RedisService,
    private readonly storage: StorageService,
    private readonly queues: QueueService,
    private readonly access: AccessService,
    private readonly ents: EntitlementsService,
    private readonly signer: SignedUrlService,
    private readonly audit: AuditService,
    private readonly analytics: AnalyticsService,
    private readonly settings: SettingsService,
    private readonly metrics: MetricsService,
    private readonly idem: IdempotencyService,
    @Inject(CONFIG) private readonly cfg: AppConfig,
  ) {}

  /** Upload intent: validates policy, reserves quota, returns an opaque media id + a short-lived upload credential. */
  async createIntent(me: Principal, eventIdParam: string | null, raw: unknown, idemKey?: string) {
    const body = IntentSchema.parse(raw);
    let eventId: string; let uploader: Uploader; let role: string;
    if (me.kind === 'guest') {
      if (!me.scopes.includes('upload')) throw E.forbidden('scope_not_granted', 'Your session cannot upload to this event.');
      eventId = me.eventId; uploader = { kind: 'guest', sessionId: me.sessionId }; role = 'guest';
    } else if (me.kind === 'user') {
      if (!eventIdParam) throw E.badRequest('event_required');
      const m = await this.access.requireMember(me, eventIdParam, 'media.upload');
      eventId = m.event.id; uploader = { kind: 'user', userId: me.userId }; role = m.role;
    } else throw E.unauthorized();

    const key = me.kind === 'guest' ? me.sessionId : (me as any).userId;
    return this.idem.run(`intent:${key}`, idemKey, { eventId, body }, () => this.intent(eventId, uploader, role, body));
  }

  private async intent(eventId: string, uploader: Uploader, role: string, body: z.infer<typeof IntentSchema>) {
    const principalKey = uploader.kind === 'guest' ? uploader.sessionId : uploader.userId;
    await this.redis.hit(`intent:${principalKey}`, this.cfg.RATE_LIMIT_UPLOAD_INTENT_PER_SESSION, 60);

    const maxBytes = await this.settings.get<number>('media.max_bytes', this.cfg.MEDIA_MAX_BYTES);
    const allowed = await this.settings.get<string[]>('media.allowed_mime', this.cfg.MEDIA_ALLOWED_MIME.split(','));
    const mime = body.mime.toLowerCase().split(';')[0].trim();
    if (!allowed.includes(mime)) throw E.unsupported('unsupported_type', 'This file type is not supported. Use JPEG, PNG, WebP or HEIC photos.');
    if (body.size > maxBytes) throw E.tooLarge('file_too_large', `Photos can be at most ${Math.floor(maxBytes / 1048576)} MB.`);

    const chunk = this.cfg.MEDIA_CHUNK_BYTES;
    const totalChunks = Math.ceil(body.size / chunk);

    const row = await this.db.tx(async (c) => {
      const ev = (await c.query<any>('SELECT * FROM events WHERE id = $1 FOR UPDATE', [eventId])).rows[0];
      if (!ev) throw E.notFound('event_not_found');
      if (uploader.kind === 'guest') {
        assertAllowed(ev.state, 'guest_upload');
        if (!ev.uploads_enabled) throw E.conflict('uploads_disabled', 'Uploads are turned off for this event.');
        const now = new Date();
        if (now < new Date(ev.upload_opens_at) || now > new Date(ev.upload_closes_at)) throw E.conflict('outside_upload_window', 'Uploads are not open right now.');
      } else {
        assertAllowed(ev.state, 'member_upload');
      }
      if (body.folder_id) {
        const f = await c.query('SELECT 1 FROM event_folders WHERE id = $1 AND event_id = $2', [body.folder_id, eventId]);
        if (!f.rows[0]) throw E.unprocessable('invalid_folder', 'Unknown folder.');
        if (uploader.kind === 'guest') throw E.forbidden('folder_not_allowed', 'Guests cannot upload into folders.');
      }
      const ent = await this.ents.effective(eventId, c);
      if (!ent.has_package) throw E.conflict('event_not_activated', 'This event is not active yet.');

      if (uploader.kind === 'guest') {
        const s = (await c.query<any>('SELECT upload_count FROM guest_sessions WHERE id = $1 FOR UPDATE', [uploader.sessionId])).rows[0];
        const cap = await this.settings.get<number>('guest.max_uploads_per_session', this.cfg.GUEST_MAX_UPLOADS_PER_SESSION);
        if (s.upload_count >= cap) throw E.tooMany(3600, 'session_upload_cap');
        const active = (await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM media WHERE uploader_session_id = $1 AND upload_state IN ('intent','uploading')`, [uploader.sessionId])).rows[0].n;
        if (active >= Math.max(ent.concurrent_uploads, 2) * 3) throw E.tooMany(30, 'too_many_active_uploads');
      }
      // quota: hard per-event limits (spec 9.6 / R3). Derivatives add ~35% over declared bytes.
      const usage = await this.ents.usage(eventId, c);
      if (usage.media_count + 1 > ent.max_media) throw E.conflict('event_media_limit', 'This event has reached its photo limit.', { reason: 'max_media' });
      if (usage.used_bytes + Math.ceil(body.size * 1.35) > ent.storage_bytes) throw E.conflict('event_storage_full', 'This event has run out of storage.', { reason: 'storage' });

      let caption = ev.captions_enabled && body.caption ? body.caption.trim().slice(0, this.cfg.CAPTION_MAX_CHARS) : null;
      // caption keyword rules (platform list + event list): guest captions that match are dropped and the photo is held for review
      let captionFlagged = false;
      if (caption && uploader.kind === 'guest') {
        const platformWords = await this.settings.get<string[]>('moderation.caption_keywords', []);
        if (captionMatches(caption, [...(ev.caption_keywords ?? []), ...platformWords])) { captionFlagged = true; caption = null; }
      }
      const id = (await c.query<{ id: string }>(
        `INSERT INTO media (event_id, folder_id, uploader_session_id, uploader_user_id, declared_mime, declared_size, caption, caption_flagged, chunk_size, total_chunks, quarantine_prefix)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pending') RETURNING id`,
        [eventId, body.folder_id ?? null, uploader.kind === 'guest' ? uploader.sessionId : null, uploader.kind === 'user' ? uploader.userId : null, mime, body.size, caption, captionFlagged, chunk, totalChunks])).rows[0].id;
      await c.query('UPDATE media SET quarantine_prefix = $2 WHERE id = $1', [id, keys.quarantinePrefix(eventId, id)]);
      if (uploader.kind === 'guest') await c.query('UPDATE guest_sessions SET upload_count = upload_count + 1 WHERE id = $1', [uploader.sessionId]);
      return { id, eventId: ev.id as string, language: ev.language as string };
    });

    this.analytics.inc(eventId, 'upload_intent');
    this.metrics.uploadsIntent.inc();
    this.markActive(eventId, 1);
    const tok = this.signer.uploadToken(row.id, eventId);
    return {
      media_id: row.id,
      upload: {
        url: `${this.cfg.PUBLIC_API_URL}/v1/uploads/${row.id}`,
        protocol: 'chunked-v1', chunk_url_template: `${this.cfg.PUBLIC_API_URL}/v1/uploads/${row.id}/chunks/{n}`,
        token: tok.token, expires_at: tok.expires_at, chunk_bytes: chunk, total_chunks: totalChunks,
        complete_url: `${this.cfg.PUBLIC_API_URL}/v1/media/${row.id}/complete`,
      },
    };
  }

  private markActive(eventId: string, delta: number): void {
    const k = `active_uploads:${eventId}`;
    this.redis.client.incrby(k, delta).then((v) => {
      this.redis.client.expire(k, 3600).catch(() => undefined);
      if (v < 0) this.redis.client.set(k, 0).catch(() => undefined);
      if (delta > 0) this.analytics.max(eventId, 'peak_active_uploads', v);
    }).catch(() => undefined);
  }

  // ------------------------------------------------------------------ chunk gateway
  private async loadForUpload(mediaId: string, token: string | undefined) {
    const { eventId } = this.signer.verifyUploadToken(token, mediaId);
    const m = await this.db.one<any>('SELECT m.*, e.state AS event_state FROM media m JOIN events e ON e.id = m.event_id WHERE m.id = $1 AND m.event_id = $2', [mediaId, eventId]);
    if (!m) throw E.notFound('media_not_found');
    return m;
  }

  /** PUT /uploads/:id/chunks/:n - idempotent: re-sending a chunk after a dropped connection simply overwrites it. */
  async putChunk(mediaId: string, n: number, token: string | undefined, body: Buffer) {
    const m = await this.loadForUpload(mediaId, token);
    if (!['intent', 'uploading'].includes(m.upload_state)) throw E.conflict('upload_closed', 'This upload can no longer accept data.', { state: m.upload_state });
    if (!stateAllows(m.event_state, 'upload_continue')) throw E.conflict('event_not_accepting_uploads', 'The event is no longer accepting uploads.');
    if (!Number.isInteger(n) || n < 0 || n >= m.total_chunks) throw E.badRequest('invalid_chunk_index');
    if (!Buffer.isBuffer(body) || body.length === 0) throw E.badRequest('empty_chunk');
    const last = n === m.total_chunks - 1;
    const expected = last ? m.declared_size - m.chunk_size * (m.total_chunks - 1) : m.chunk_size;
    if (body.length !== expected) throw E.badRequest('invalid_chunk_size', `Chunk ${n} must be ${expected} bytes.`, { expected, got: body.length });
    await this.storage.put('quarantine', keys.quarantinePart(m.event_id, m.id, n), body, 'application/octet-stream');
    const sha = createHash('sha256').update(body).digest('hex');
    await this.db.query(
      `INSERT INTO upload_parts (media_id, part_no, size_bytes, sha256) VALUES ($1,$2,$3,$4) ON CONFLICT (media_id, part_no) DO UPDATE SET size_bytes = EXCLUDED.size_bytes, sha256 = EXCLUDED.sha256`,
      [m.id, n, body.length, sha]);
    await this.db.query(`UPDATE media SET upload_state = 'uploading', upload_started_at = COALESCE(upload_started_at, now()) WHERE id = $1 AND upload_state IN ('intent','uploading')`, [m.id]);
    const count = (await this.db.one<{ n: number }>('SELECT count(*)::int AS n FROM upload_parts WHERE media_id = $1', [m.id]))!.n;
    return { received: n, received_count: count, total_chunks: m.total_chunks };
  }

  /** GET /uploads/:id - resume support: which chunks has the server stored? */
  async status(mediaId: string, token: string | undefined) {
    const m = await this.loadForUpload(mediaId, token);
    const parts = await this.db.many<{ part_no: number }>('SELECT part_no FROM upload_parts WHERE media_id = $1 ORDER BY part_no', [mediaId]);
    return { state: m.upload_state, received: parts.map((p) => p.part_no), total_chunks: m.total_chunks, chunk_bytes: m.chunk_size, declared_size: Number(m.declared_size) };
  }

  async cancel(mediaId: string, token: string | undefined) {
    const m = await this.loadForUpload(mediaId, token);
    if (!['intent', 'uploading'].includes(m.upload_state)) return { state: m.upload_state };
    await this.db.query(`UPDATE media SET upload_state = 'cancelled', failure_code = 'cancelled_by_client' WHERE id = $1 AND upload_state IN ('intent','uploading')`, [mediaId]);
    await this.storage.deletePrefix('quarantine', keys.quarantinePrefix(m.event_id, m.id)).catch(() => undefined);
    this.markActive(m.event_id, -1);
    return { state: 'cancelled' };
  }

  /** POST /media/:id/complete - verifies all chunks are present, then hands the object to the processing queue. */
  async complete(mediaId: string, token: string | undefined, idemKey?: string) {
    return this.idem.run(`complete:${mediaId}`, idemKey, {}, async () => {
      const m = await this.loadForUpload(mediaId, token);
      if (['uploaded', 'processing', 'ready', 'duplicate'].includes(m.upload_state)) return this.publicState(m);
      if (!['intent', 'uploading'].includes(m.upload_state)) throw E.conflict('upload_closed', 'This upload can no longer be completed.', { state: m.upload_state });
      if (!stateAllows(m.event_state, 'upload_continue')) throw E.conflict('event_not_accepting_uploads', 'The event is no longer accepting uploads.');
      const parts = await this.db.many<{ part_no: number; size_bytes: number }>('SELECT part_no, size_bytes FROM upload_parts WHERE media_id = $1 ORDER BY part_no', [mediaId]);
      const have = new Set(parts.map((p) => p.part_no));
      const missing = Array.from({ length: m.total_chunks }, (_, i) => i).filter((i) => !have.has(i));
      if (missing.length) throw E.conflict('incomplete_upload', 'Some chunks are missing.', { missing });
      if (parts.reduce((a, p) => a + p.size_bytes, 0) !== Number(m.declared_size)) throw E.conflict('size_mismatch', 'Uploaded size does not match the declared size.');
      const upd = await this.db.query(`UPDATE media SET upload_state = 'uploaded', completed_at = now() WHERE id = $1 AND upload_state IN ('intent','uploading')`, [mediaId]);
      if (upd.rowCount) {
        await this.queues.add(QUEUES.media, 'process', { mediaId }, { jobId: `media-${mediaId}` });
        this.analytics.inc(m.event_id, 'upload_complete');
        this.markActive(m.event_id, -1);
      }
      return { media_id: mediaId, state: 'uploaded' as const };
    });
  }

  private publicState(m: any) { return { media_id: m.id, state: m.upload_state === 'ready' ? 'ready' : m.upload_state }; }
}
