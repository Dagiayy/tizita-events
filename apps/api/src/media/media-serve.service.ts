import { Injectable } from '@nestjs/common';
import type { Response } from 'express';
import { AuditService } from '../audit/audit.service';
import { E } from '../common/errors';
import { stateAllows } from '../events/lifecycle';
import { Db } from '../infra/db.service';
import { StorageService } from '../infra/storage.service';
import { SignedUrlService } from './signed-url.service';

/**
 * Streams media through the API after (1) HMAC signature + expiry verification and (2) a fresh check of the
 * media's CURRENT state - so hiding/rejecting/deleting a photo, or suspending an event, takes effect immediately
 * even for URLs that were already issued.
 */
@Injectable()
export class MediaServeService {
  constructor(private readonly db: Db, private readonly signer: SignedUrlService, private readonly storage: StorageService, private readonly audit: AuditService) {}

  async serve(mediaId: string, variant: string, q: Record<string, string | undefined>, res: Response): Promise<void> {
    if (!/^[0-9a-f-]{36}$/i.test(mediaId) || !['thumb', 'gallery', 'viewer', 'original'].includes(variant)) throw E.notFound('media_not_found');
    const sig = this.signer.verifyMedia(mediaId, variant, q);
    const m = await this.db.one<any>(
      `SELECT m.id, m.event_id, m.upload_state, m.moderation_state, m.deleted_at, m.folder_id, m.mime, e.state AS event_state, e.downloads_enabled, e.allow_original_download,
              f.publication_state, f.download_allowed AS folder_dl, d.object_key, d.mime AS dmime, d.byte_size, d.checksum
         FROM media m JOIN events e ON e.id = m.event_id LEFT JOIN event_folders f ON f.id = m.folder_id
         LEFT JOIN media_derivatives d ON d.media_id = m.id AND d.variant = $2 WHERE m.id = $1`, [mediaId, variant]);
    if (!m || !m.object_key || m.deleted_at || m.upload_state !== 'ready') throw E.notFound('media_not_found');

    if (sig.audience === 'pub') {
      const visible = m.moderation_state === 'approved' && (!m.folder_id || m.publication_state === 'published') && stateAllows(m.event_state, 'guest_view');
      if (!visible) throw E.notFound('media_not_found');
      if (variant === 'original' || sig.download) {
        if (!stateAllows(m.event_state, 'guest_download') || !m.downloads_enabled || m.folder_dl === false) throw E.forbidden('downloads_disabled');
        if (variant === 'original' && !m.allow_original_download) throw E.forbidden('original_not_available');
      }
      if (variant === 'original' && !sig.download) throw E.forbidden('invalid_signature');
    } else if (sig.audience === 'stf') {
      if (variant === 'original' || ['deleted', 'suspended'].includes(m.event_state)) throw E.notFound('media_not_found');
    } else {
      // elevated admin access: the grant must exist, be approved and unexpired; every view is audited
      const g = await this.db.one<any>(
        `SELECT * FROM media_access_grants WHERE id = $1 AND state = 'approved' AND expires_at > now() AND event_id = $2 AND (media_id IS NULL OR media_id = $3)`, [sig.grant ?? null, m.event_id, mediaId]);
      if (!g) throw E.forbidden('grant_invalid', 'The media access grant is missing, expired or revoked.');
      await this.audit.record({ action: 'admin.media_viewed', resourceType: 'media', resourceId: mediaId, eventId: m.event_id, reason: g.reason, after: { grant_id: g.id, variant } });
    }

    const { stream } = await this.storage.getStream('media', m.object_key);
    res.setHeader('Content-Type', m.dmime ?? 'image/jpeg');
    res.setHeader('Content-Length', String(m.byte_size));
    res.setHeader('ETag', `"${m.checksum.slice(0, 32)}"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Robots-Tag', 'noindex, noarchive');
    res.setHeader('Cache-Control', sig.audience === 'pub' ? `private, max-age=${Math.max(0, Math.min(3600, Number(q.exp) - Math.floor(Date.now() / 1000)))}` : 'private, no-store');
    if (sig.download) {
      const ext = (m.dmime ?? 'image/jpeg') === 'image/png' ? 'png' : (m.dmime ?? '').includes('webp') ? 'webp' : (m.dmime ?? '').includes('hei') ? 'heic' : 'jpg';
      res.setHeader('Content-Disposition', `attachment; filename="event-photo-${mediaId.slice(0, 8)}.${ext}"`);
    } else res.setHeader('Content-Disposition', 'inline');
    if (res.req.headers['if-none-match'] === `"${m.checksum.slice(0, 32)}"`) { stream.destroy(); res.status(304).end(); return; }
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  }

  async serveCover(code: string, exp: string | undefined, sig: string | undefined, res: Response): Promise<void> {
    this.signer.verifyCover(code, exp, sig);
    const ev = await this.db.one<{ cover_object_key: string | null; state: string }>('SELECT cover_object_key, state FROM events WHERE public_code = $1', [code]);
    if (!ev?.cover_object_key || ev.state === 'deleted' || ev.state === 'suspended') throw E.notFound('cover_not_found');
    const { stream, size } = await this.storage.getStream('media', ev.cover_object_key);
    res.setHeader('Content-Type', 'image/jpeg');
    if (size) res.setHeader('Content-Length', String(size));
    res.setHeader('Cache-Control', 'private, max-age=600');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    stream.pipe(res);
  }
}
