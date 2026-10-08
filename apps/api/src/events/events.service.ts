import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import sharp from 'sharp';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service';
import { AppConfig, CONFIG } from '../common/config';
import { CryptoService, JOIN_CODE_ALPHABET, randomFromAlphabet, randomToken } from '../common/crypto';
import { E } from '../common/errors';
import { normalizeEthiopianPhone } from '../common/phone';
import { Principal } from '../common/request-context';
import { Db } from '../infra/db.service';
import { StorageService, keys } from '../infra/storage.service';
import { NotificationsService } from '../notifications/notifications.service';
import { AccessService, Perm, Role } from './access.service';
import { EntitlementsService } from './entitlements.service';
import { assertAllowed, allowedActions, EventState } from './lifecycle';
import { LifecycleService } from './lifecycle.service';

export const EVENT_TYPES = ['wedding', 'birthday', 'graduation', 'conference', 'corporate', 'party', 'family', 'cultural', 'other'] as const;
const UPLOAD_MODES = ['open', 'code', 'passcode', 'verified_phone'] as const;
const GALLERY_MODES = ['open', 'code', 'passcode', 'verified_phone', 'view_only'] as const;
const isoDate = z.string().datetime({ offset: true }).transform((s) => new Date(s));
const MAX_WINDOW_DAYS = 30;
const DEFAULT_FOLDERS: [string, string][] = [['Pre-event', 'pre_event'], ['Ceremony', 'ceremony'], ['Reception', 'reception'], ['Highlights', 'highlights']];

const settingsShape = {
  upload_access_mode: z.enum(UPLOAD_MODES),
  gallery_access_mode: z.enum(GALLERY_MODES),
  join_code_scope: z.enum(['upload', 'gallery', 'both']),
  privacy_mode: z.enum(['private', 'public']),
  uploads_enabled: z.boolean(),
  moderation_mode: z.enum(['pre', 'post']),
  comments_enabled: z.boolean(),
  reactions_enabled: z.boolean(),
  downloads_enabled: z.boolean(),
  allow_original_download: z.boolean(),
  watermark_enabled: z.boolean(),
  guest_name_required: z.boolean(),
  captions_enabled: z.boolean(),
  slideshow_enabled: z.boolean(),
  show_uploader_names: z.boolean(),
  report_hide_threshold: z.number().int().min(1).max(20),
  caption_keywords: z.array(z.string().trim().min(1).max(40)).max(50),
};
const coreShape = {
  name: z.string().trim().min(1).max(120),
  type: z.enum(EVENT_TYPES),
  starts_at: isoDate,
  ends_at: isoDate,
  upload_opens_at: isoDate,
  upload_closes_at: isoDate,
  timezone: z.string().max(60).refine((tz) => { try { new Intl.DateTimeFormat('en', { timeZone: tz }); return true; } catch { return false; } }, 'Unknown timezone'),
  city: z.string().trim().min(1).max(80),
  region: z.string().trim().max(80),
  venue: z.string().trim().max(160),
  host_name: z.string().trim().max(120),
  language: z.enum(['en', 'am']),
  brand_color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
};

export const CreateEventSchema = z.object({
  ...coreShape,
  country: z.literal('ET', { errorMap: () => ({ message: 'Events can only be created in Ethiopia (ET).' }) }).optional(),
  upload_opens_at: coreShape.upload_opens_at.optional(),
  upload_closes_at: coreShape.upload_closes_at.optional(),
  timezone: coreShape.timezone.default('Africa/Addis_Ababa'),
  region: coreShape.region.optional(),
  venue: coreShape.venue.optional(),
  host_name: coreShape.host_name.optional(),
  brand_color: coreShape.brand_color.optional(),
  language: coreShape.language.default('en'),
  ...Object.fromEntries(Object.entries(settingsShape).map(([k, v]) => [k, (v as z.ZodTypeAny).optional()])),
}).strict() as z.ZodType<any>;

export const UpdateEventSchema = z.object({
  ...Object.fromEntries(Object.entries({ ...coreShape, ...settingsShape }).map(([k, v]) => [k, (v as z.ZodTypeAny).optional()])),
  region: coreShape.region.nullable().optional(),
  venue: coreShape.venue.nullable().optional(),
  host_name: coreShape.host_name.nullable().optional(),
}).strict() as z.ZodType<any>;

const CORE_FIELDS = new Set(Object.keys(coreShape));
const SETTINGS_ACCESS_FIELDS = new Set(Object.keys(settingsShape));

@Injectable()
export class EventsService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
    private readonly crypto: CryptoService,
    private readonly access: AccessService,
    private readonly ents: EntitlementsService,
    private readonly lifecycle: LifecycleService,
    private readonly storage: StorageService,
    private readonly notify: NotificationsService,
    @Inject(CONFIG) private readonly cfg: AppConfig,
  ) {}

  // ------------------------------------------------------------ create / read
  async create(me: Principal, raw: unknown) {
    if (me.kind !== 'user') throw E.unauthorized();
    const input = CreateEventSchema.parse(raw);
    const opens: Date = input.upload_opens_at ?? input.starts_at;
    const closes: Date = input.upload_closes_at ?? new Date(input.ends_at.getTime() + 12 * 3600_000);
    this.validateWindow(input.starts_at, input.ends_at, opens, closes);
    this.validateSettings({ privacy_mode: input.privacy_mode ?? 'private', upload_access_mode: input.upload_access_mode ?? 'code', gallery_access_mode: input.gallery_access_mode ?? 'code', comments_enabled: input.comments_enabled, reactions_enabled: input.reactions_enabled }, false);

    const publicCode = randomFromAlphabet('abcdefghjkmnpqrstuvwxyz23456789', 14);
    const eventId = await this.db.tx(async (c) => {
      const ev = (await c.query<{ id: string }>(
        `INSERT INTO events (public_code, owner_id, name, type, starts_at, ends_at, upload_opens_at, upload_closes_at, timezone, city, region, venue, host_name, language,
                             brand_color, privacy_mode, upload_access_mode, gallery_access_mode, join_code_scope, uploads_enabled, moderation_mode, downloads_enabled,
                             allow_original_download, watermark_enabled, guest_name_required, captions_enabled, slideshow_enabled, report_hide_threshold)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28) RETURNING id`,
        [publicCode, me.userId, input.name, input.type, input.starts_at, input.ends_at, opens, closes, input.timezone, input.city, input.region ?? null, input.venue ?? null,
          input.host_name ?? null, input.language, input.brand_color ?? null, input.privacy_mode ?? 'private', input.upload_access_mode ?? 'code', input.gallery_access_mode ?? 'code',
          input.join_code_scope ?? 'upload', input.uploads_enabled ?? true, input.moderation_mode ?? 'pre', input.downloads_enabled ?? true, input.allow_original_download ?? false,
          input.watermark_enabled ?? false, input.guest_name_required ?? false, input.captions_enabled ?? false, input.slideshow_enabled ?? true, input.report_hide_threshold ?? 1])).rows[0];
      await c.query(`INSERT INTO event_members (event_id, user_id, role, status, can_manage_billing) VALUES ($1,$2,'owner','active',true)`, [ev.id, me.userId]);
      await this.createSecrets(c, ev.id, me.userId);
      let i = 0;
      for (const [name, kind] of DEFAULT_FOLDERS) {
        await c.query(`INSERT INTO event_folders (event_id, name, kind, sort_order, created_by) VALUES ($1,$2,$3,$4,$5)`, [ev.id, name, kind, i++, me.userId]);
      }
      await this.audit.record({ action: 'event.created', resourceType: 'event', resourceId: ev.id, eventId: ev.id, after: { state: 'draft', type: input.type, city: input.city } }, c);
      return ev.id as string;
    });
    return this.get(me, eventId);
  }

  private async createSecrets(q: { query: Function }, eventId: string, userId: string) {
    const upload = 'u_' + randomToken(24);
    const gallery = 'g_' + randomToken(24);
    const code = await this.uniqueJoinCode(q);
    for (const [type, tok] of [['upload_token', upload], ['gallery_token', gallery], ['join_code', code]] as const) {
      await q.query(`INSERT INTO access_secrets (event_id, secret_type, token_hash, token_enc, created_by) VALUES ($1,$2,$3,$4,$5)`,
        [eventId, type, this.crypto.hmac(tok, 'event-token'), this.crypto.encrypt(tok), userId]);
    }
  }

  async uniqueJoinCode(q: { query: Function }): Promise<string> {
    for (let i = 0; i < 20; i++) {
      const code = randomFromAlphabet(JOIN_CODE_ALPHABET, 8);
      const exists = await q.query('SELECT 1 FROM access_secrets WHERE token_hash = $1 AND revoked_at IS NULL', [this.crypto.hmac(code, 'event-token')]);
      if (!exists.rows.length) return code;
    }
    throw new Error('could not allocate join code');
  }

  private validateWindow(starts: Date, ends: Date, opens: Date, closes: Date) {
    if (ends < starts) throw E.unprocessable('invalid_dates', 'The event end must be after its start.');
    if (closes <= opens) throw E.unprocessable('invalid_upload_window', 'The upload window must close after it opens.');
    if ((closes.getTime() - opens.getTime()) / 86400_000 > MAX_WINDOW_DAYS) throw E.unprocessable('upload_window_too_long', `The upload window can be at most ${MAX_WINDOW_DAYS} days.`);
  }

  /** Cross-field rules: private-by-default, open modes need explicit public opt-in, deferred features are flag-gated. */
  validateSettings(s: { privacy_mode: string; upload_access_mode: string; gallery_access_mode: string; comments_enabled?: boolean; reactions_enabled?: boolean }, passcodeSet: boolean) {
    if (s.privacy_mode === 'private' && (s.upload_access_mode === 'open' || s.gallery_access_mode === 'open')) {
      throw E.unprocessable('open_requires_public', 'Open access needs the event privacy set to "public" (explicit opt-in).');
    }
    if ((s.upload_access_mode === 'passcode' || s.gallery_access_mode === 'passcode') && !passcodeSet) {
      throw E.unprocessable('passcode_not_set', 'Set an event passcode before choosing passcode access.');
    }
    if (s.comments_enabled && !this.cfg.FEATURE_COMMENTS) throw E.unprocessable('feature_not_enabled', 'Comments are not available yet.');
    if (s.reactions_enabled && !this.cfg.FEATURE_REACTIONS) throw E.unprocessable('feature_not_enabled', 'Reactions are not available yet.');
  }

  async list(me: Principal) {
    if (me.kind !== 'user') throw E.unauthorized();
    const rows = await this.db.many<any>(
      `SELECT e.*, m.role FROM events e JOIN event_members m ON m.event_id = e.id AND m.user_id = $1 AND m.status = 'active'
        WHERE e.state <> 'deleted' ORDER BY e.starts_at DESC LIMIT 200`, [me.userId]);
    return { events: rows.map((r) => this.dto(r, r.role)) };
  }

  async get(me: Principal, eventId: string) {
    const { event, role } = await this.access.requireMember(me, eventId, 'event.view');
    const ent = await this.ents.effective(eventId);
    const dto = this.dto(event, role);
    return { ...dto, entitlement: ent, usage: await this.ents.usage(eventId) };
  }

  /** Short-lived signed link to the event cover (same scheme the guest context uses). */
  private coverUrl(publicCode: string): string {
    const exp = Math.floor(Date.now() / 1000) + this.cfg.SIGNED_URL_TTL_SEC;
    return `${this.cfg.PUBLIC_API_URL}/v1/c/${publicCode}?exp=${exp}&sig=${this.crypto.sign(`cover:${publicCode}:${exp}`)}`;
  }

  dto(e: any, role?: Role) {
    return {
      id: e.id, public_code: e.public_code, name: e.name, type: e.type, state: e.state, role,
      starts_at: e.starts_at, ends_at: e.ends_at, upload_opens_at: e.upload_opens_at, upload_closes_at: e.upload_closes_at,
      timezone: e.timezone, country: e.country, city: e.city, region: e.region, venue: e.venue, host_name: e.host_name, language: e.language,
      has_cover: !!e.cover_object_key, cover_url: e.cover_object_key ? this.coverUrl(e.public_code) : null, brand_color: e.brand_color,
      settings: {
        privacy_mode: e.privacy_mode, upload_access_mode: e.upload_access_mode, gallery_access_mode: e.gallery_access_mode, join_code_scope: e.join_code_scope,
        uploads_enabled: e.uploads_enabled, moderation_mode: e.moderation_mode, comments_enabled: e.comments_enabled, reactions_enabled: e.reactions_enabled,
        downloads_enabled: e.downloads_enabled, allow_original_download: e.allow_original_download, watermark_enabled: e.watermark_enabled,
        guest_name_required: e.guest_name_required, captions_enabled: e.captions_enabled, slideshow_enabled: e.slideshow_enabled, show_uploader_names: e.show_uploader_names, report_hide_threshold: e.report_hide_threshold, caption_keywords: e.caption_keywords ?? [],
      },
      lifecycle: {
        closed_at: e.closed_at, read_only_at: e.read_only_at, archived_at: e.archived_at, retention_until: e.retention_until,
        deletion_requested_at: e.deletion_requested_at, deletion_deadline: e.deletion_deadline, legal_hold: e.legal_hold,
        suspended: e.state === 'suspended' ? { reason_visible: true, message_key: 'event.suspended_notice' } : undefined,
      },
      allowed_actions: allowedActions(e.state as EventState),
      media_count: e.media_count, storage_bytes: e.storage_bytes, created_at: e.created_at,
    };
  }

  // ------------------------------------------------------------ update
  async update(me: Principal, eventId: string, raw: unknown) {
    const { event, role } = await this.access.requireMember(me, eventId, 'event.update');
    const input = UpdateEventSchema.parse(raw) as Record<string, any>;
    const keysIn = Object.keys(input);
    if (!keysIn.length) return this.dto(event, role);
    if (keysIn.some((k) => CORE_FIELDS.has(k))) assertAllowed(event.state, 'configure_core');
    if (keysIn.some((k) => SETTINGS_ACCESS_FIELDS.has(k))) assertAllowed(event.state, 'configure_access');

    const merged = { ...event, ...input };
    const pass = await this.db.one('SELECT 1 FROM access_secrets WHERE event_id = $1 AND secret_type = \'passcode\' AND revoked_at IS NULL', [eventId]);
    this.validateSettings(merged, !!pass);
    this.validateWindow(new Date(merged.starts_at), new Date(merged.ends_at), new Date(merged.upload_opens_at), new Date(merged.upload_closes_at));
    const ent = await this.ents.effective(eventId);
    if (input.watermark_enabled && ent.has_package && !ent.watermark) throw E.forbidden('plan_feature_unavailable', 'Watermarking is not included in your package.');
    if (input.allow_original_download && !ent.allow_original_export) throw E.forbidden('plan_feature_unavailable', 'Original downloads are not included in your package.');

    const sets: string[] = []; const params: unknown[] = [eventId];
    for (const [k, v] of Object.entries(input)) { params.push(v); sets.push(`${k} = $${params.length}`); }
    await this.db.tx(async (c) => {
      await c.query(`UPDATE events SET ${sets.join(', ')}, updated_at = now() WHERE id = $1`, params);
      await this.audit.record({ action: 'event.updated', resourceType: 'event', resourceId: eventId, eventId, before: pick(event, keysIn), after: pick(merged, keysIn) }, c);
      // changing the window of a draft/scheduled event may require a re-clock
    });
    // keep the clock-driven state coherent after window edits
    await this.lifecycle.tick();
    return this.get(me, eventId);
  }

  // ------------------------------------------------------------ closing / extending / archive / delete
  async close(me: Principal, eventId: string, body: { mode: 'now' | 'schedule'; at?: string }) {
    const { event } = await this.access.requireMember(me, eventId, 'event.close');
    if (body.mode === 'schedule') {
      assertAllowed(event.state, 'extend');
      if (!body.at) throw E.badRequest('at_required', 'Provide the scheduled close time.');
      const at = new Date(body.at);
      if (!(at > new Date())) throw E.unprocessable('close_in_past', 'The scheduled close time must be in the future.');
      if (at <= new Date(event.upload_opens_at)) throw E.unprocessable('invalid_upload_window', 'Close time must be after the upload window opens.');
      await this.db.tx(async (c) => {
        await c.query('UPDATE events SET upload_closes_at = $2, updated_at = now() WHERE id = $1', [eventId, at]);
        await this.audit.record({ action: 'event.close_scheduled', resourceType: 'event', resourceId: eventId, eventId, before: { upload_closes_at: event.upload_closes_at }, after: { upload_closes_at: at.toISOString() } }, c);
      });
    } else {
      assertAllowed(event.state, 'close');
      await this.lifecycle.transition(eventId, 'closing', { trigger: 'host', reason: 'host closed uploads' });
    }
    return this.get(me, eventId);
  }

  async extend(me: Principal, eventId: string, uploadClosesAt: string) {
    const { event } = await this.access.requireMember(me, eventId, 'event.close');
    assertAllowed(event.state, 'extend');
    const at = new Date(uploadClosesAt);
    if (!(at > new Date())) throw E.unprocessable('close_in_past', 'The new close time must be in the future.');
    if ((at.getTime() - new Date(event.upload_opens_at).getTime()) / 86400_000 > MAX_WINDOW_DAYS) throw E.unprocessable('upload_window_too_long', `The upload window can be at most ${MAX_WINDOW_DAYS} days.`);
    await this.db.tx(async (c) => {
      await c.query('UPDATE events SET upload_closes_at = $2, updated_at = now() WHERE id = $1', [eventId, at]);
      await this.audit.record({ action: 'event.extended', resourceType: 'event', resourceId: eventId, eventId, before: { upload_closes_at: event.upload_closes_at }, after: { upload_closes_at: at.toISOString() } }, c);
    });
    if (event.state === 'closing') await this.lifecycle.transition(eventId, 'live', { trigger: 'host', reason: 'window extended', patch: { closed_at: null } });
    return this.get(me, eventId);
  }

  async archive(me: Principal, eventId: string) {
    const { event } = await this.access.requireMember(me, eventId, 'event.close');
    assertAllowed(event.state, 'archive');
    await this.lifecycle.transition(eventId, 'archived', { trigger: 'host', reason: 'host archived event' });
    return this.get(me, eventId);
  }
  async restore(me: Principal, eventId: string) {
    const { event } = await this.access.requireMember(me, eventId, 'event.close');
    assertAllowed(event.state, 'restore');
    if (event.retention_until && new Date(event.retention_until) < new Date()) throw E.conflict('retention_ended', 'The retention period has ended.');
    await this.lifecycle.transition(eventId, 'read_only', { trigger: 'host', reason: 'host restored event' });
    return this.get(me, eventId);
  }

  /** Host deletion request: starts the grace period (7-30 days); the owner can cancel until the purge deadline. */
  async requestDeletion(me: Principal, eventId: string, confirmName: string) {
    const { event } = await this.access.requireMember(me, eventId, 'event.delete');
    assertAllowed(event.state, 'request_deletion');
    if (confirmName.trim() !== event.name.trim()) throw E.unprocessable('confirmation_mismatch', 'Type the event name exactly to confirm deletion.');
    if (event.legal_hold) throw E.conflict('legal_hold', 'This event is under a legal hold and cannot be deleted right now. Contact support.');
    await this.lifecycle.transition(eventId, 'deletion_pending', { trigger: 'host', reason: 'host requested deletion', deletionTrigger: 'host_request', requestedBy: me.kind === 'user' ? me.userId : null });
    return this.get(me, eventId);
  }
  async cancelDeletion(me: Principal, eventId: string) {
    const { event } = await this.access.requireMember(me, eventId, 'event.delete');
    assertAllowed(event.state, 'cancel_deletion');
    await this.lifecycle.restoreState(eventId, { trigger: 'host', reason: 'host cancelled deletion' });
    return this.get(me, eventId);
  }

  // ------------------------------------------------------------ members
  async listMembers(me: Principal, eventId: string) {
    await this.access.requireMember(me, eventId, 'event.view');
    const rows = await this.db.many(
      `SELECT m.id, m.role, m.status, m.created_at, u.display_name, u.phone_last4 FROM event_members m LEFT JOIN users u ON u.id = m.user_id
        WHERE m.event_id = $1 AND m.status <> 'removed' ORDER BY m.created_at`, [eventId]);
    return { members: rows };
  }

  async inviteMember(me: Principal, eventId: string, body: { phone: string; role: 'moderator' | 'photographer' }) {
    const { event } = await this.access.requireMember(me, eventId, 'event.members');
    const phone = normalizeEthiopianPhone(body.phone);
    if (!phone) throw E.badRequest('invalid_phone', 'Enter a valid Ethiopian mobile number.');
    const hash = this.crypto.hmac(phone, 'phone');
    const user = await this.db.one<{ id: string }>('SELECT id FROM users WHERE phone_hash = $1', [hash]);
    if (user?.id === (me as any).userId) throw E.conflict('already_member', 'You already own this event.');
    const dup = await this.db.one(`SELECT 1 FROM event_members WHERE event_id = $1 AND status <> 'removed' AND (user_id = $2 OR invite_phone_hash = $3)`, [eventId, user?.id ?? null, hash]);
    if (dup) throw E.conflict('already_member', 'This person is already on the team.');
    await this.ents.assertCanAdd(eventId, body.role === 'photographer' ? 'photographer' : 'collaborator');
    await this.db.tx(async (c) => {
      const dup = await c.query(`SELECT 1 FROM event_members WHERE event_id = $1 AND status <> 'removed' AND (user_id = $2 OR invite_phone_hash = $3)`, [eventId, user?.id ?? null, hash]);
      if (dup.rows.length) throw E.conflict('already_member', 'This person is already on the team.');
      await c.query(
        `INSERT INTO event_members (event_id, user_id, invite_phone_hash, role, status, invited_by) VALUES ($1,$2,$3,$4,$5,$6)`,
        [eventId, user?.id ?? null, user ? null : hash, body.role, user ? 'active' : 'invited', (me as any).userId]);
      await this.audit.record({ action: 'event.member_invited', resourceType: 'event', resourceId: eventId, eventId, after: { role: body.role, existing_user: !!user } }, c);
    });
    if (!user) await this.notify.sendNow({ phone, template: 'invite_collaborator', locale: event.language, params: { event: event.name }, eventId }).catch(() => undefined);
    return this.listMembers(me, eventId);
  }

  async removeMember(me: Principal, eventId: string, memberId: string) {
    await this.access.requireMember(me, eventId, 'event.members');
    const r = await this.db.query(`UPDATE event_members SET status = 'removed' WHERE id = $1 AND event_id = $2 AND role <> 'owner' AND status <> 'removed'`, [memberId, eventId]);
    if (r.rowCount === 0) throw E.notFound('member_not_found');
    await this.audit.record({ action: 'event.member_removed', resourceType: 'event_member', resourceId: memberId, eventId });
    return { ok: true };
  }

  // ------------------------------------------------------------ folders
  async listFolders(me: Principal, eventId: string) {
    await this.access.requireMember(me, eventId, 'event.view');
    return { folders: await this.db.many(
      `SELECT f.id, f.name, f.kind, f.sort_order, f.publication_state, f.download_allowed, f.watermark,
              (SELECT count(*)::int FROM media m WHERE m.folder_id = f.id AND m.deleted_at IS NULL AND m.upload_state = 'ready') AS media_count
         FROM event_folders f WHERE f.event_id = $1 ORDER BY f.sort_order, f.created_at`, [eventId]) };
  }
  async createFolder(me: Principal, eventId: string, body: { name: string; kind?: string; publication_state?: 'draft' | 'published'; download_allowed?: boolean; watermark?: boolean }) {
    const { userId } = await this.access.requireMember(me, eventId, 'folder.manage');
    const r = await this.db.one<{ id: string }>(
      `INSERT INTO event_folders (event_id, name, kind, sort_order, publication_state, download_allowed, watermark, created_by)
       VALUES ($1,$2,$3,(SELECT COALESCE(max(sort_order),0)+1 FROM event_folders WHERE event_id = $1),$4,$5,$6,$7) RETURNING id`,
      [eventId, body.name, body.kind ?? 'custom', body.publication_state ?? 'published', body.download_allowed ?? true, body.watermark ?? false, userId]);
    await this.audit.record({ action: 'folder.created', resourceType: 'folder', resourceId: r!.id, eventId });
    return this.listFolders(me, eventId);
  }
  async updateFolder(me: Principal, folderId: string, body: Partial<{ name: string; publication_state: 'draft' | 'published'; download_allowed: boolean; watermark: boolean; cover_media_id: string | null; sort_order: number }>) {
    const f = await this.db.one<any>('SELECT * FROM event_folders WHERE id = $1', [folderId]);
    if (!f) throw E.notFound('folder_not_found');
    const { role, userId } = await this.access.requireMember(me, f.event_id, 'folder.manage');
    if (role === 'photographer' && f.created_by !== userId) throw E.forbidden('insufficient_event_role', 'Photographers can only manage their own folders.');
    const sets: string[] = []; const params: unknown[] = [folderId];
    for (const [k, v] of Object.entries(body)) { params.push(v); sets.push(`${k} = $${params.length}`); }
    if (!sets.length) return { ok: true };
    if (body.cover_media_id) {
      const ok = await this.db.one('SELECT 1 FROM media WHERE id = $1 AND event_id = $2', [body.cover_media_id, f.event_id]);
      if (!ok) throw E.unprocessable('invalid_cover');
    }
    await this.db.query(`UPDATE event_folders SET ${sets.join(', ')} WHERE id = $1`, params);
    await this.audit.record({ action: 'folder.updated', resourceType: 'folder', resourceId: folderId, eventId: f.event_id, after: body as any });
    return { ok: true };
  }
  async deleteFolder(me: Principal, folderId: string) {
    const f = await this.db.one<any>('SELECT * FROM event_folders WHERE id = $1', [folderId]);
    if (!f) throw E.notFound('folder_not_found');
    await this.access.requireMember(me, f.event_id, 'event.update');
    await this.db.query('DELETE FROM event_folders WHERE id = $1', [folderId]); // media.folder_id -> NULL
    await this.audit.record({ action: 'folder.deleted', resourceType: 'folder', resourceId: folderId, eventId: f.event_id });
    return { ok: true };
  }

  // ------------------------------------------------------------ cover image
  async setCover(me: Principal, eventId: string, image: Buffer) {
    const { event } = await this.access.requireMember(me, eventId, 'event.update');
    assertAllowed(event.state, 'configure_core');
    if (image.length > 3 * 1024 * 1024) throw E.tooLarge('cover_too_large', 'Cover image must be under 3 MB.');
    let out: Buffer;
    try {
      out = await sharp(image, { limitInputPixels: 40_000_000, failOn: 'error' }).rotate().resize({ width: 1600, height: 900, fit: 'cover' }).jpeg({ quality: 82 }).toBuffer();
    } catch { throw E.unsupported('invalid_image', 'The cover must be a valid JPEG, PNG or WebP image.'); }
    const key = keys.cover(eventId, randomUUID());
    await this.storage.put('media', key, out, 'image/jpeg');
    const old = event.cover_object_key as string | null;
    await this.db.query('UPDATE events SET cover_object_key = $2, updated_at = now() WHERE id = $1', [eventId, key]);
    if (old) await this.storage.delete('media', old).catch(() => undefined);
    await this.audit.record({ action: 'event.cover_set', resourceType: 'event', resourceId: eventId, eventId });
    return { ok: true };
  }

  // ------------------------------------------------------------ insights (spec 6.2 / 17)
  async insights(me: Principal, eventId: string) {
    await this.access.requireMember(me, eventId, 'insights.view');
    const [m, peak, funnel, views] = await Promise.all([
      this.db.one<any>(
        `SELECT count(*) FILTER (WHERE upload_state='ready')::int AS uploads,
                count(DISTINCT COALESCE(uploader_session_id::text, uploader_user_id::text)) FILTER (WHERE upload_state='ready')::int AS contributors,
                count(*) FILTER (WHERE moderation_state='approved' AND upload_state='ready')::int AS approved,
                count(*) FILTER (WHERE moderation_state='pending' AND upload_state='ready')::int AS pending,
                count(*) FILTER (WHERE moderation_state='rejected')::int AS rejected,
                count(*) FILTER (WHERE moderation_state='flagged')::int AS flagged,
                count(*) FILTER (WHERE upload_state='failed')::int AS failed,
                percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (published_at - created_at))) FILTER (WHERE published_at IS NOT NULL) AS median_publish_seconds
           FROM media WHERE event_id = $1 AND deleted_at IS NULL`, [eventId]),
      this.db.one<any>(
        `SELECT date_trunc('hour', created_at) AS hour_eat, count(*)::int AS n FROM media
          WHERE event_id = $1 AND upload_state = 'ready' GROUP BY 1 ORDER BY n DESC LIMIT 1`, [eventId]),
      this.db.many<any>('SELECT metric, sum(n)::bigint AS n FROM analytics_counters WHERE event_id = $1 GROUP BY metric', [eventId]),
      this.db.one<any>(`SELECT count(*) FILTER (WHERE step = 'gallery_view')::int AS unique_viewers FROM analytics_session_steps WHERE event_id = $1`, [eventId]),
    ]);
    const f = Object.fromEntries(funnel.map((r: any) => [r.metric, Number(r.n)]));
    const usage = await this.ents.usage(eventId);
    return {
      uploads: m.uploads, unique_contributors: m.contributors, approvals: m.approved, pending: m.pending, rejected: m.rejected, flagged: m.flagged, failed_uploads: m.failed,
      median_publish_seconds: m.median_publish_seconds === null ? null : Math.round(Number(m.median_publish_seconds)),
      views: f.gallery_view ?? 0, unique_viewers: views?.unique_viewers ?? 0, downloads: f.download ?? 0, shares: f.share ?? 0,
      // peak hour is an instant (EAT hours align with UTC hours, +03:00); clients render it in EAT
      peak_upload_hour_eat: peak?.hour_eat ? new Date(peak.hour_eat).toISOString() : null, peak_upload_count: peak?.n ?? 0, peak_concurrent_uploads: f.peak_active_uploads ?? 0,
      storage: { used_bytes: usage.used_bytes, quota_bytes: usage.ent.storage_bytes, percent: usage.percent, alert_level: usage.alert_level },
      funnel: { landing_view: f.landing_view ?? 0, join: f.join ?? 0, capture_select: f.capture_select ?? 0, upload_intent: f.upload_intent ?? 0, upload_complete: f.upload_complete ?? 0, approved: f.approved ?? 0, gallery_view: f.gallery_view ?? 0, download: f.download ?? 0, share: f.share ?? 0 },
    };
  }
}

function pick(o: Record<string, any>, ks: string[]) { return Object.fromEntries(ks.map((k) => [k, o[k] instanceof Date ? o[k].toISOString() : o[k]])); }
export type { Perm };
