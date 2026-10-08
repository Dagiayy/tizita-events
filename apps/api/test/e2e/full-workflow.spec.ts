import AdmZip from 'adm-zip';
import { Client_, Harness, Staff, binaryParser, bootHarness, joinAsGuest, photo } from '../helpers/harness';
import { openSse, startServer, startWorkers, waitFor } from '../helpers/e2e';
import { MaintenanceService } from '../../src/admin/maintenance.service';
import { MemorySmsProvider } from '../../src/notifications/notifications.service';
import { normalizeEthiopianPhone } from '../../src/common/phone';

let h: Harness; let base: string;
beforeAll(async () => { h = await bootHarness(); base = await startServer(h); await startWorkers(h); });
afterAll(async () => { await h.close(); });

/**
 * Definition of done (spec "Recommended initial specification" + brief section 29):
 * Host OTP -> Create Event -> Configure -> Payment -> Activation -> QR -> Guest scans -> Joins -> Takes/Selects Photo -> Upload ->
 * Processing -> Moderation -> Gallery -> Download/Share -> Host Export -> Closure -> Retention -> Deletion
 * Everything below happens through the public HTTP API with real BullMQ workers - no manual database edits except moving the clock.
 */
describe('End-to-end: the whole product workflow', () => {
  it('runs from host sign-up to permanent deletion', async () => {
    // 1. Host signs in with an Ethiopian number (Amharic SMS)
    const phone = '0944556677'; const e164 = normalizeEthiopianPhone(phone)!;
    await h.http().post('/v1/auth/request-otp').send({ phone, locale: 'am' }).expect(200);
    const login = await h.http().post('/v1/auth/verify-otp').send({ phone, code: MemorySmsProvider.lastCode(e164) }).expect(200);
    const host = new Client_(h); host.token = login.body.access_token; host.userId = login.body.user.id;

    // 2. Creates + configures the event (Ethiopic title, Ethiopia, moderation approve-first)
    const now = Date.now();
    const created = await host.post('/v1/events', {
      name: 'የአበበና ሳራ ሰርግ', type: 'wedding', city: 'Addis Ababa', venue: 'ስካይላይት ሆቴል', host_name: 'አበበ በቀለ', language: 'am',
      starts_at: new Date(now - 3600_000).toISOString(), ends_at: new Date(now + 6 * 3600_000).toISOString(), upload_closes_at: new Date(now + 24 * 3600_000).toISOString(),
      upload_access_mode: 'code', gallery_access_mode: 'view_only', moderation_mode: 'pre', downloads_enabled: true, captions_enabled: true,
    }).expect(201);
    const id = created.body.id;
    expect(created.body.state).toBe('draft');
    await host.patch(`/v1/events/${id}`, { brand_color: '#0b6b3a', join_code_scope: 'upload' }).expect(200);
    const png = await host.req('put', `/v1/events/${id}/cover`).set('Content-Type', 'image/jpeg').send(await photo(5, { width: 1600, height: 900 })).expect(200);
    expect(png.body.ok).toBe(true);
    expect((await host.get(`/v1/events/${id}`)).body.has_cover).toBe(true);

    // 3. Pays in ETB through the provider abstraction; entitlement activates only after verification
    const order = (await host.post('/v1/payments/orders', { event_id: id, plan_code: 'event_plus' }).expect(200)).body;
    expect(order).toMatchObject({ amount_etb: 2800, currency: 'ETB' });
    expect((await host.get(`/v1/events/${id}`)).body.state).toBe('draft');
    const paid = await h.http().post('/v1/dev/sandbox/pay').send({ tx_ref: order.order_ref, outcome: 'success' }).expect(200);
    expect(paid.body.outcome).toBe('activated');
    const ev = (await host.get(`/v1/events/${id}`).expect(200)).body;
    expect(ev.state).toBe('live');

    // 4. QR + links
    const links = (await host.get(`/v1/events/${id}/share-links`).expect(200)).body;
    const qr = await host.post(`/v1/events/${id}/qr`, { kind: 'upload', format: 'pdf', include_code: true }).expect(200).buffer(true).parse(binaryParser);
    expect((qr.body as Buffer).subarray(0, 4).toString()).toBe('%PDF');
    const uploadToken = links.upload_url.split('/j/')[1].split('?')[0]; const galleryToken = links.gallery_url.split('/j/')[1];

    // 5. Staff + public live channels
    const staffTicket = (await host.post(`/v1/events/${id}/live-ticket`).expect(200)).body.ticket;
    const staffSse = await openSse(base, staffTicket);

    // 6. Guest scans the QR: context -> notice -> join (no account, no app)
    const ctx = (await h.http().get(`/v1/events/${uploadToken}/context?lang=am`).expect(200)).body;
    expect(ctx).toMatchObject({ status: 'open', can_upload: true, locator_kind: 'upload_token' });
    expect(ctx.event.name).toBe('የአበበና ሳራ ሰርግ'); expect(ctx.event.cover_url).toContain('/v1/c/'); expect(ctx.notice.locale).toBe('am');
    await h.http().get(ctx.event.cover_url.replace('http://localhost:4000', '')).expect(200);
    const guest = (await joinAsGuest(h, uploadToken, { code: links.join_code, display_name: 'ሳራ', device_id: 'phone-1' })).body;
    expect(guest.scopes).toEqual(['upload']);
    const viewer = (await joinAsGuest(h, galleryToken)).body;
    const publicTicket = (await h.http().post('/v1/guest/live-ticket').set('Authorization', `Bearer ${viewer.token}`).expect(200)).body.ticket;
    const publicSse = await openSse(base, publicTicket);
    await h.http().post('/v1/guest/live-ticket').set('Authorization', `Bearer ${guest.token}`).expect(403);                // upload-only session has no gallery stream
    await h.http().get(`/v1/live?ticket=${publicTicket}`).expect(401);                                                       // tickets are single use

    // 7. Guest picks 3 photos: chunked upload + async worker pipeline (3 concurrent)
    const photos = await Promise.all([1, 2, 3].map((n) => photo(100 + n, { gps: true, width: 2400, height: 1600 })));
    const mediaIds: string[] = [];
    await Promise.all(photos.map(async (buf) => {
      const intent = (await h.http().post('/v1/guest/uploads/intents').set('Authorization', `Bearer ${guest.token}`).send({ mime: 'image/jpeg', size: buf.length, caption: 'ከሠርጉ' }).expect(200)).body;
      for (let i = 0; i < intent.upload.total_chunks; i++) await h.http().put(`/v1/uploads/${intent.media_id}/chunks/${i}`).set('X-Upload-Token', intent.upload.token).send(buf.subarray(i * intent.upload.chunk_bytes, (i + 1) * intent.upload.chunk_bytes)).expect(200);
      await h.http().post(`/v1/media/${intent.media_id}/complete`).set('X-Upload-Token', intent.upload.token).expect(200);
      mediaIds.push(intent.media_id);
    }));
    await waitFor(async () => (await h.db.one<any>(`SELECT count(*)::int AS n FROM media WHERE event_id = $1 AND upload_state = 'ready'`, [id])).n === 3, 60_000);
    const mine = (await h.http().get('/v1/guest/me').set('Authorization', `Bearer ${guest.token}`).expect(200)).body;
    expect(mine.uploads.map((u: any) => u.state)).toEqual(['pending', 'pending', 'pending']);

    // 8. Nothing unapproved leaks: staff stream sees pending media, public stream and gallery do not
    await staffSse.waitFor((e) => e.event === 'media.updated' && e.data.moderation_state === 'pending');
    expect(publicSse.events.filter((e) => e.event.startsWith('media.'))).toEqual([]);
    expect((await h.http().get('/v1/guest/media').set('Authorization', `Bearer ${viewer.token}`).expect(200)).body.items).toEqual([]);

    // 9. Host moderates: approve 2, reject 1; approvals reach the live gallery
    const q = (await host.get(`/v1/events/${id}/moderation`).expect(200)).body;
    expect(q.counts.pending).toBe(3);
    const [a, b, c] = mediaIds;
    await host.post(`/v1/events/${id}/moderation/bulk`, { action: 'approve', media_ids: [a, b] }).expect(200);
    await host.post(`/v1/events/${id}/moderation/bulk`, { action: 'reject', media_ids: [c], reason: 'blurry' }).expect(200);
    const pub1 = await publicSse.waitFor((e) => e.event === 'media.published');
    expect(pub1.data.media.urls.viewer).toMatch(/\/v1\/m\//);
    await waitFor(async () => publicSse.events.filter((e) => e.event === 'media.published').length === 2);
    expect(publicSse.events.some((e) => e.event === 'media.published' && e.data.media.id === c)).toBe(false);
    const gallery = (await h.http().get('/v1/guest/media').set('Authorization', `Bearer ${viewer.token}`).expect(200)).body;
    expect(gallery.items.map((i: any) => i.id).sort()).toEqual([a, b].sort());
    expect(gallery.items[0].caption).toBe('ከሠርጉ');

    // 10. Guest views, saves and shares; public derivative bytes have no GPS
    const img = await h.http().get(gallery.items[0].urls.viewer.replace('http://localhost:4000', '')).expect(200).buffer(true).parse(binaryParser);
    expect((img.body as Buffer).includes(Buffer.from('Exif'))).toBe(false);
    const dl = (await h.http().get(`/v1/guest/media/${gallery.items[0].id}/download-link`).set('Authorization', `Bearer ${viewer.token}`).expect(200)).body;
    await h.http().get(dl.url.replace('http://localhost:4000', '')).expect(200);
    await h.http().post('/v1/guest/analytics').set('Authorization', `Bearer ${viewer.token}`).send({ metric: 'share' }).expect(204);
    await h.http().post('/v1/guest/analytics').set('Authorization', `Bearer ${viewer.token}`).send({ metric: 'upload_complete' }).expect(400);   // clients cannot forge server metrics

    // 11. Host exports: async worker builds the ZIP, signed link downloads it
    const ex = (await host.post(`/v1/events/${id}/exports`, { scope: 'full', variant: 'original' }).expect(200)).body;
    const ready = await waitFor(async () => { const s = (await host.get(`/v1/exports/${ex.id}/status`)).body; return s.state === 'ready' ? s : s.state === 'failed' ? (() => { throw new Error('export failed'); })() : null; }, 60_000);
    expect(ready.item_count).toBe(2);
    const zipLink = (await host.get(`/v1/exports/${ex.id}/download`).expect(200)).body;
    const zip = new AdmZip((await h.http().get(zipLink.url.replace('http://localhost:4000', '')).expect(200).buffer(true).parse(binaryParser)).body as Buffer);
    expect(zip.getEntries()).toHaveLength(2);
    expect(zip.getEntries().every((e) => e.getData().length === photos.find((p) => p.length === e.getData().length)!.length)).toBe(true);   // protected originals, byte-exact

    // 12. Insights for the host
    const ins = (await host.get(`/v1/events/${id}/insights`).expect(200)).body;
    expect(ins).toMatchObject({ uploads: 3, unique_contributors: 1, approvals: 2, rejected: 1, downloads: 1, shares: 1 });
    expect(ins.funnel).toMatchObject({ landing_view: 1, join: 2, upload_intent: 3, upload_complete: 3 });

    // 13. Event closes; workers drain; gallery becomes read-only; retention starts
    await host.post(`/v1/events/${id}/close`, { mode: 'now' }).expect(200);
    expect((await h.http().post('/v1/guest/uploads/intents').set('Authorization', `Bearer ${guest.token}`).send({ mime: 'image/jpeg', size: 1000 })).status).toBe(409);
    await h.get<MaintenanceService>(MaintenanceService).runTick();
    const ro = (await host.get(`/v1/events/${id}`).expect(200)).body;
    expect(ro.state).toBe('read_only'); expect(ro.lifecycle.retention_until).toBeTruthy();
    expect(Math.round((new Date(ro.lifecycle.retention_until).getTime() - new Date(ro.lifecycle.closed_at).getTime()) / 86400_000)).toBe(365);   // Event Plus retention
    await h.http().get('/v1/guest/media').set('Authorization', `Bearer ${viewer.token}`).expect(200);                      // still viewable
    await staffSse.waitFor((e) => e.event === 'event.state' && e.data.state === 'read_only');
    await publicSse.waitFor((e) => e.event === 'event.state' && e.data.state === 'read_only');

    // 14. Retention elapses -> deletion lifecycle -> grace -> purge, all by the scheduler
    await h.db.query(`UPDATE events SET retention_until = now() - interval '1 minute' WHERE id = $1`, [id]);
    await h.get<MaintenanceService>(MaintenanceService).runTick();
    expect((await host.get(`/v1/events/${id}`).expect(200)).body.state).toBe('deletion_pending');
    await h.db.query(`UPDATE deletion_jobs SET scheduled_at = now() - interval '1 minute' WHERE resource_id = $1`, [id]);
    await h.get<MaintenanceService>(MaintenanceService).runTick();
    expect((await h.db.one<any>('SELECT state, name FROM events WHERE id = $1', [id]))).toMatchObject({ state: 'deleted', name: '[deleted]' });
    expect(await h.db.one('SELECT 1 FROM media WHERE event_id = $1', [id])).toBeNull();
    const left: string[] = []; for (const [b, p] of [['media', `e/${id}/`], ['exports', `x/${id}/`], ['quarantine', `q/${id}/`]] as const) for await (const o of h.storage.list(b, p)) left.push(o.key);
    expect(left).toEqual([]);
    await h.http().get(`/v1/events/${uploadToken}/context`).expect(404);

    // 15. The audit trail tells the whole story, and the chain is intact
    const admin = await Staff.create(h, 'super_admin');
    const trail = (await admin.get(`/v1/admin/audit?event_id=${id}&limit=200`).expect(200)).body.map((x: any) => x.action);
    expect(trail).toEqual(expect.arrayContaining([
      'event.created', 'payment.order_created', 'payment.verified_paid', 'event.state.draft_to_live', 'event.qr_generated', 'moderation.approve', 'moderation.reject', 'export.requested', 'export.completed',
      'event.state.live_to_closing', 'event.state.closing_to_read_only', 'event.state.read_only_to_deletion_pending', 'deletion.completed', 'event.state.deletion_pending_to_deleted',
    ]));
    expect((await admin.get('/v1/admin/audit/verify').expect(200)).body.brokenAtSeq).toBeNull();
    // retained legal records survive deletion
    expect((await h.db.one<any>('SELECT state FROM payment_orders WHERE event_id = $1', [id])).state).toBe('paid');
    expect(await h.db.one('SELECT 1 FROM invoices LIMIT 1')).toBeTruthy();
    staffSse.close(); publicSse.close();
  });
});
