import { Inject, Injectable } from '@nestjs/common';
import { AnalyticsService } from '../analytics/analytics.service';
import { AppConfig, CONFIG } from '../common/config';
import { E } from '../common/errors';
import { Principal } from '../common/request-context';
import { AccessService } from '../events/access.service';
import { EntitlementsService } from '../events/entitlements.service';
import { assertAllowed } from '../events/lifecycle';
import { Db } from '../infra/db.service';
import { SignedUrlService } from '../media/signed-url.service';
import { RealtimeService } from './realtime.service';

type Cursor = { t: string; id: string };
/** Cursor timestamps keep full microsecond precision (JS Dates would truncate to ms and skip rows that share a timestamp). */
const TS_FULL = (col: string) => `to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
/** Opaque, stable per-sender key (event-scoped hash; never the session or user id). */
const SENDER_KEY = `substr(encode(sha256(convert_to(COALESCE(m.uploader_session_id::text, m.uploader_user_id::text, 'none') || m.event_id::text, 'UTF8')), 'hex'), 1, 12)`;
const SENDER_NAME = `NULLIF(btrim(COALESCE(gs.display_name, u.display_name, '')), '')`;
const SENDER_JOIN = `LEFT JOIN guest_sessions gs ON gs.id = m.uploader_session_id LEFT JOIN users u ON u.id = m.uploader_user_id`;
const enc = (c: Cursor) => Buffer.from(JSON.stringify(c)).toString('base64url');
function dec(s?: string): Cursor | null {
  if (!s) return null;
  try { const c = JSON.parse(Buffer.from(s, 'base64url').toString('utf8')); if (typeof c.t === 'string' && /^[0-9a-f-]{36}$/i.test(c.id) && !isNaN(Date.parse(c.t))) return c; } catch { /* fallthrough */ }
  throw E.badRequest('invalid_cursor');
}

export const HOST_FILTERS = ['all', 'approved', 'pending', 'rejected', 'flagged', 'hidden', 'highlights', 'newest'] as const;
export type HostFilter = (typeof HOST_FILTERS)[number];

@Injectable()
export class GalleryService {
  constructor(
    private readonly db: Db,
    private readonly signer: SignedUrlService,
    private readonly access: AccessService,
    private readonly ents: EntitlementsService,
    private readonly analytics: AnalyticsService,
    private readonly realtime: RealtimeService,
    @Inject(CONFIG) private readonly cfg: AppConfig,
  ) {}

  /**
   * Guest gallery: event-scoped via the signed guest session, newest-first keyset pagination, only media that is
   * ready + approved and not in an unpublished folder. Pending/rejected/hidden/flagged media never appears.
   */
  async listForGuest(me: Principal, q: { cursor?: string; limit?: number; folder_id?: string; highlights?: boolean; sender?: string; mine?: boolean }) {
    if (me.kind !== 'guest') throw E.unauthorized();
    if (!me.scopes.includes('gallery')) throw E.forbidden('scope_not_granted', 'This link does not include gallery access.');
    const ev = await this.db.one<any>('SELECT * FROM events WHERE id = $1', [me.eventId]);
    if (!ev) throw E.notFound('event_not_found');
    assertAllowed(ev.state, 'guest_view');
    const cur = dec(q.cursor);
    const limit = Math.min(Math.max(q.limit ?? 30, 1), 60);
    const params: unknown[] = [me.eventId];
    let where = `m.event_id = $1 AND m.upload_state = 'ready' AND m.moderation_state = 'approved' AND m.deleted_at IS NULL AND m.published_at IS NOT NULL
                 AND (m.folder_id IS NULL OR f.publication_state = 'published')`;
    if (q.folder_id) { params.push(q.folder_id); where += ` AND m.folder_id = $${params.length}`; }
    if (q.highlights) where += ' AND m.is_highlight';
    if (q.mine) { params.push(me.sessionId); where += ` AND m.uploader_session_id = $${params.length}`; }
    if (q.sender && ev.show_uploader_names) { if (!/^[0-9a-f]{12}$/.test(q.sender)) throw E.badRequest('invalid_sender'); params.push(q.sender); where += ` AND ${SENDER_KEY} = $${params.length}`; }
    if (cur) { params.push(cur.t, cur.id); where += ` AND (m.published_at, m.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`; }
    params.push(limit + 1);
    const rows = await this.db.many<any>(
      `SELECT m.id, m.width, m.height, m.published_at, ${TS_FULL('m.published_at')} AS cursor_ts, m.is_highlight, m.caption, m.folder_id, m.uploader_session_id, f.download_allowed AS folder_dl,
              ${SENDER_KEY} AS sender_key, ${SENDER_NAME} AS sender_name
         FROM media m LEFT JOIN event_folders f ON f.id = m.folder_id ${SENDER_JOIN} WHERE ${where} ORDER BY m.published_at DESC, m.id DESC LIMIT $${params.length}`, params);
    const page = rows.slice(0, limit);
    if (!q.cursor) {
      this.analytics.inc(me.eventId, 'gallery_view');
      void this.analytics.step(me.sessionId, me.eventId, 'gallery_view').then(async (first) => {
        if (first) await this.db.query('UPDATE guest_sessions SET first_gallery_view_at = now() WHERE id = $1', [me.sessionId]).catch(() => undefined);
      });
    }
    const canDl = ev.downloads_enabled && ['live', 'closing', 'read_only'].includes(ev.state);
    return {
      items: page.map((r) => ({
        id: r.id, width: r.width, height: r.height, published_at: r.published_at, is_highlight: r.is_highlight, caption: r.caption, folder_id: r.folder_id,
        mine: r.uploader_session_id === me.sessionId, can_download: canDl && r.folder_dl !== false,
        sender: ev.show_uploader_names ? { key: r.sender_key, name: r.sender_name } : null,
        urls: { thumb: this.signer.mediaUrl(r.id, 'thumb', 'pub'), gallery: this.signer.mediaUrl(r.id, 'gallery', 'pub'), viewer: this.signer.mediaUrl(r.id, 'viewer', 'pub') },
      })),
      next_cursor: rows.length > limit ? enc({ t: page[page.length - 1].cursor_ts, id: page[page.length - 1].id }) : null,
    };
  }

  /** Published albums with photo count and up to 3 cover thumbnails (Pinterest-style boards). */
  async guestFolders(me: Principal) {
    if (me.kind !== 'guest' || !me.scopes.includes('gallery')) throw E.forbidden('scope_not_granted');
    const rows = await this.db.many<any>(
      `SELECT f.id, f.name, f.kind,
              (SELECT count(*)::int FROM media m WHERE m.folder_id = f.id AND m.upload_state = 'ready' AND m.moderation_state = 'approved' AND m.deleted_at IS NULL) AS count,
              ARRAY(SELECT m.id FROM media m WHERE m.folder_id = f.id AND m.upload_state = 'ready' AND m.moderation_state = 'approved' AND m.deleted_at IS NULL
                     ORDER BY m.is_highlight DESC, m.published_at DESC LIMIT 3) AS cover_ids
         FROM event_folders f WHERE f.event_id = $1 AND f.publication_state = 'published'
          AND EXISTS (SELECT 1 FROM media m WHERE m.folder_id = f.id AND m.upload_state = 'ready' AND m.moderation_state = 'approved' AND m.deleted_at IS NULL)
        ORDER BY f.sort_order`, [me.eventId]);
    return { folders: rows.map((r) => ({ id: r.id, name: r.name, kind: r.kind, count: r.count, covers: (r.cover_ids as string[]).map((id) => this.signer.mediaUrl(id, 'thumb', 'pub')) })) };
  }

  /** "By sender" boards: one entry per sender name with photo count and cover thumbnails. Hidden when the host turns names off. */
  async guestSenders(me: Principal) {
    if (me.kind !== 'guest' || !me.scopes.includes('gallery')) throw E.forbidden('scope_not_granted');
    const ev = await this.db.one<any>('SELECT show_uploader_names FROM events WHERE id = $1', [me.eventId]);
    if (!ev?.show_uploader_names) return { enabled: false, senders: [], unnamed: 0 };
    const rows = await this.db.many<any>(
      `SELECT ${SENDER_KEY} AS key, ${SENDER_NAME} AS name, (m.uploader_session_id = $2) AS mine, count(*)::int AS count,
              (array_agg(m.id ORDER BY m.published_at DESC))[1:3] AS cover_ids, max(m.published_at) AS latest
         FROM media m LEFT JOIN event_folders f ON f.id = m.folder_id ${SENDER_JOIN}
        WHERE m.event_id = $1 AND m.upload_state = 'ready' AND m.moderation_state = 'approved' AND m.deleted_at IS NULL AND m.published_at IS NOT NULL
          AND (m.folder_id IS NULL OR f.publication_state = 'published')
        GROUP BY 1, 2, 3 ORDER BY max(m.published_at) DESC LIMIT 200`, [me.eventId, me.sessionId]);
    const toDto = (r: any) => ({ key: r.key, name: r.name, mine: !!r.mine, count: r.count, covers: (r.cover_ids as string[]).map((id) => this.signer.mediaUrl(id, 'thumb', 'pub')) });
    const named = rows.filter((r) => r.name).map(toDto);
    const anon = rows.filter((r) => !r.name);
    return { enabled: true, senders: named, unnamed: anon.reduce((n, r) => n + r.count, 0) };
  }

  /** Short-lived URL for saving a photo. Honours: event download switch, folder permission, plan + host rule for originals. */
  async downloadLink(me: Principal, mediaId: string, variant: 'viewer' | 'original') {
    if (me.kind !== 'guest' || !me.scopes.includes('gallery')) throw E.forbidden('scope_not_granted');
    const m = await this.db.one<any>(
      `SELECT m.*, e.state AS event_state, e.downloads_enabled, e.allow_original_download, f.download_allowed AS folder_dl, f.publication_state
         FROM media m JOIN events e ON e.id = m.event_id LEFT JOIN event_folders f ON f.id = m.folder_id
        WHERE m.id = $1 AND m.event_id = $2 AND m.upload_state = 'ready' AND m.moderation_state = 'approved' AND m.deleted_at IS NULL`, [mediaId, me.eventId]);
    if (!m || (m.folder_id && m.publication_state !== 'published')) throw E.notFound('media_not_found');
    assertAllowed(m.event_state, 'guest_download');
    if (!m.downloads_enabled || m.folder_dl === false) throw E.forbidden('downloads_disabled', 'The host turned off downloads for this event.');
    if (variant === 'original') {
      const ent = await this.ents.effective(m.event_id);
      if (!m.allow_original_download || !ent.allow_original_export || !m.original_key) throw E.forbidden('original_not_available', 'Original quality is not available for this photo.');
    }
    this.analytics.inc(m.event_id, 'download');
    return { url: this.signer.mediaUrl(mediaId, variant, 'pub', { download: true, ttlSec: 300 }), expires_in: 300, filename: `event-photo-${mediaId.slice(0, 8)}.${variant === 'original' ? (m.mime === 'image/png' ? 'png' : m.mime === 'image/webp' ? 'webp' : m.mime?.includes('hei') ? 'heic' : 'jpg') : 'jpg'}` };
  }

  async liveTicket(me: Principal) {
    if (me.kind !== 'guest' || !me.scopes.includes('gallery')) throw E.forbidden('scope_not_granted');
    return this.realtime.issueTicket(me.eventId, 'public', me.sessionId);
  }

  // ------------------------------------------------------------------ host / moderator gallery management
  async listForMember(me: Principal, eventId: string, q: { filter?: HostFilter; folder_id?: string; sender?: string; cursor?: string; limit?: number }) {
    const { role, userId } = await this.access.requireMember(me, eventId, 'media.view_own');
    const limit = Math.min(Math.max(q.limit ?? 40, 1), 100);
    const params: unknown[] = [eventId];
    let where = `m.event_id = $1 AND m.deleted_at IS NULL AND m.upload_state IN ('ready','duplicate','failed','processing','uploaded')`;
    const f = q.filter ?? 'newest';
    if (role === 'photographer') { params.push(userId); where += ` AND m.uploader_user_id = $${params.length}`; }
    if (f === 'approved' || f === 'pending' || f === 'rejected' || f === 'flagged' || f === 'hidden') { params.push(f); where += ` AND m.moderation_state = $${params.length} AND m.upload_state = 'ready'`; }
    else if (f === 'highlights') where += ' AND m.is_highlight AND m.upload_state = \'ready\'';
    else where += ` AND m.upload_state IN ('ready','processing','uploaded','failed')`;
    if (q.folder_id) { params.push(q.folder_id); where += ` AND m.folder_id = $${params.length}`; }
    if (q.sender) { if (!/^[0-9a-f]{12}$/.test(q.sender)) throw E.badRequest('invalid_sender'); params.push(q.sender); where += ` AND ${SENDER_KEY} = $${params.length}`; }
    const cur = dec(q.cursor);
    if (cur) { params.push(cur.t, cur.id); where += ` AND (m.created_at, m.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`; }
    params.push(limit + 1);
    const rows = await this.db.many<any>(
      `SELECT m.id, m.upload_state, m.moderation_state, m.is_highlight, m.width, m.height, m.created_at, ${TS_FULL('m.created_at')} AS cursor_ts, m.folder_id, m.caption, m.failure_code,
              m.near_dup_of_media_id IS NOT NULL AS near_duplicate, m.stored_bytes, m.uploader_user_id, m.uploader_session_id,
              (SELECT count(*)::int FROM moderation_reports r WHERE r.media_id = m.id AND r.status IN ('open','escalated')) AS open_reports,
              ${SENDER_KEY} AS sender_key, ${SENDER_NAME} AS sender_name
         FROM media m ${SENDER_JOIN} WHERE ${where} ORDER BY m.created_at DESC, m.id DESC LIMIT $${params.length}`, params);
    const page = rows.slice(0, limit);
    return {
      items: page.map((r) => ({
        id: r.id, upload_state: r.upload_state, moderation_state: r.moderation_state, is_highlight: r.is_highlight, width: r.width, height: r.height, created_at: r.created_at,
        folder_id: r.folder_id, caption: r.caption, failure_code: r.failure_code, near_duplicate: r.near_duplicate, open_reports: r.open_reports, bytes: r.stored_bytes,
        uploader: r.uploader_user_id ? 'member' : 'guest', uploader_session_id: role === 'photographer' ? undefined : r.uploader_session_id,
        sender: { key: r.sender_key, name: r.sender_name },
        urls: r.upload_state === 'ready' ? { thumb: this.signer.mediaUrl(r.id, 'thumb', 'stf'), gallery: this.signer.mediaUrl(r.id, 'gallery', 'stf'), viewer: this.signer.mediaUrl(r.id, 'viewer', 'stf') } : null,
      })),
      next_cursor: rows.length > limit ? enc({ t: page[page.length - 1].cursor_ts, id: page[page.length - 1].id }) : null,
    };
  }

  /** Host / moderator view of who uploaded what (named senders + a count of anonymous uploads). */
  async memberSenders(me: Principal, eventId: string) {
    const { role, userId } = await this.access.requireMember(me, eventId, 'media.view_own');
    const params: unknown[] = [eventId];
    let where = `m.event_id = $1 AND m.deleted_at IS NULL AND m.upload_state IN ('ready','processing','uploaded','failed')`;
    if (role === 'photographer') { params.push(userId); where += ` AND m.uploader_user_id = $2`; }
    const rows = await this.db.many<any>(
      `SELECT ${SENDER_KEY} AS key, ${SENDER_NAME} AS name, count(*)::int AS count FROM media m ${SENDER_JOIN} WHERE ${where} GROUP BY 1, 2 ORDER BY count(*) DESC LIMIT 300`, params);
    return { senders: rows.map((r) => ({ key: r.key, name: r.name, count: r.count })) };
  }
}
