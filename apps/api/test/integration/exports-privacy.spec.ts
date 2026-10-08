import AdmZip from 'adm-zip';
import sharp from 'sharp';
import { Client_, Harness, Staff, binaryParser, bootHarness, createEvent, guestUpload, joinAsGuest, photo } from '../helpers/harness';
import { ExportsService } from '../../src/exports/exports.service';
import { DeletionService } from '../../src/privacy/deletion.service';
import { SignedUrlService } from '../../src/media/signed-url.service';

let h: Harness;
beforeAll(async () => { h = await bootHarness(); });
afterAll(async () => { await h.close(); });

async function seed(host: Client_, n = 4) {
  const ev = await createEvent(h, host);
  const g = (await joinAsGuest(h, ev.uploadToken, { code: ev.joinCode })).body;
  const ids: string[] = [];
  for (let i = 0; i < n; i++) ids.push((await guestUpload(h, g, await photo(200 + i, { gps: true }))).mediaId!);
  return { ev, g, ids };
}

describe('Exports (asynchronous ZIP, signed time-limited links)', () => {
  it('#11 host exports the event: async job -> ready -> signed link -> ZIP of approved optimized photos without metadata', async () => {
    const host = await Client_.host(h);
    const { ev, ids } = await seed(host);
    await host.post(`/v1/events/${ev.id}/moderation/bulk`, { action: 'approve', media_ids: ids.slice(0, 3) }).expect(200);    // 4th stays pending
    const created = await host.req('post', `/v1/events/${ev.id}/exports`).set('Idempotency-Key', 'export-key-0001').send({ scope: 'full' }).expect(200);
    expect(created.body.state).toBe('queued');
    const again = await host.req('post', `/v1/events/${ev.id}/exports`).set('Idempotency-Key', 'export-key-0001').send({ scope: 'full' }).expect(200);
    expect(again.body.id).toBe(created.body.id);
    await host.get(`/v1/exports/${created.body.id}/download`).expect(409);                  // not ready yet
    await h.get<ExportsService>(ExportsService).build(created.body.id);
    const st = await host.get(`/v1/exports/${created.body.id}/status`).expect(200);
    expect(st.body).toMatchObject({ state: 'ready', item_count: 3, scope: 'full', variant: 'optimized' });
    expect(new Date(st.body.expires_at).getTime()).toBeGreaterThan(Date.now());

    const link = await host.get(`/v1/exports/${created.body.id}/download`).expect(200);
    expect(link.body.url).toMatch(/\/v1\/exports\/.+\/file\?exp=\d+&sig=/);
    expect(link.body.url).not.toMatch(/minio|bucket|x\//i);
    const zipRes = await h.http().get(link.body.url.replace('http://localhost:4000', '')).expect(200).buffer(true).parse(binaryParser);
    expect(zipRes.headers['content-type']).toBe('application/zip');
    expect(zipRes.headers['content-disposition']).toMatch(/attachment/);
    const zip = new AdmZip(zipRes.body as Buffer);
    const entries = zip.getEntries();
    expect(entries).toHaveLength(3);
    for (const e of entries) {
      expect(e.entryName).toMatch(/^[^/]+\/photo-\d{5}-\d{4}-\d{2}-\d{2}\.jpg$/);              // generated names only
      const meta = await sharp(e.getData()).metadata();
      expect(meta.format).toBe('jpeg'); expect(meta.exif).toBeUndefined();
    }
    // the link is signed and expires; tampering fails; other hosts/guests get nothing
    await h.http().get(link.body.url.replace('http://localhost:4000', '').replace(/sig=[^&]+/, 'sig=bad')).expect(403);
    const signer = h.get<SignedUrlService>(SignedUrlService);
    const expired = (() => { const exp = Math.floor(Date.now() / 1000) - 5; return `/v1/exports/${created.body.id}/file?exp=${exp}&sig=${h.crypto.sign(`x:${created.body.id}:${exp}`)}`; })();
    expect((await h.http().get(expired)).body.error.code).toBe('link_expired');
    const other = await Client_.host(h);
    await other.get(`/v1/exports/${created.body.id}/status`).expect(404);
    await other.get(`/v1/exports/${created.body.id}/download`).expect(404);
    await h.http().get(`/v1/exports/${created.body.id}/download`).expect(401);
    expect(await h.db.one(`SELECT 1 FROM audit_events WHERE action = 'export.download_link_issued'`)).toBeTruthy();
    void signer;
  });

  it('folder + selected exports; originals need the plan entitlement and stored originals', async () => {
    const host = await Client_.host(h);
    const { ev, ids } = await seed(host, 3);
    const folders = (await host.get(`/v1/events/${ev.id}/folders`).expect(200)).body.folders;
    expect(folders.map((f: any) => f.name)).toEqual(['Pre-event', 'Ceremony', 'Reception', 'Highlights']);
    const ceremony = folders.find((f: any) => f.name === 'Ceremony').id;
    await host.post(`/v1/events/${ev.id}/moderation/bulk`, { action: 'approve', media_ids: ids }).expect(200);
    await host.patch(`/v1/media/${ids[0]}`, { folder_id: ceremony, is_highlight: true }).expect(200);
    await host.patch(`/v1/media/${ids[1]}`, { folder_id: ceremony }).expect(200);
    const ex = (await host.post(`/v1/events/${ev.id}/exports`, { scope: 'folder', folder_id: ceremony }).expect(200)).body;
    await h.get<ExportsService>(ExportsService).build(ex.id);
    const link = (await host.get(`/v1/exports/${ex.id}/download`).expect(200)).body;
    const z = new AdmZip((await h.http().get(link.url.replace('http://localhost:4000', '')).expect(200).buffer(true).parse(binaryParser)).body as Buffer);
    expect(z.getEntries().map((e) => e.entryName.split('/')[0])).toEqual(['Ceremony', 'Ceremony']);
    const sel = (await host.post(`/v1/events/${ev.id}/exports`, { scope: 'selected', media_ids: [ids[2]] }).expect(200)).body;
    await h.get<ExportsService>(ExportsService).build(sel.id);
    expect((await host.get(`/v1/exports/${sel.id}/status`)).body.item_count).toBe(1);
    // trial plan: no original export
    const denied = await host.post(`/v1/events/${ev.id}/exports`, { scope: 'full', variant: 'original' });
    expect(denied.status).toBe(403); expect(denied.body.error.code).toBe('plan_feature_unavailable');
    await host.post(`/v1/events/${ev.id}/exports`, { scope: 'folder' }).expect(400);
    await host.post(`/v1/events/${ev.id}/exports`, { scope: 'selected', media_ids: [] }).expect(400);
    await host.post(`/v1/events/${ev.id}/exports`, { scope: 'everything' }).expect(400);
  });

  it('Event Plus: protected originals are stored, exportable only by the host, and never reachable by guests', async () => {
    const host = await Client_.host(h);
    const ev = await createEvent(h, host, {}, 'none');
    const o = (await host.post('/v1/payments/orders', { event_id: ev.id, plan_code: 'event_plus' })).body;
    await h.http().post('/v1/dev/sandbox/pay').send({ tx_ref: o.order_ref, outcome: 'success' }).expect(200);
    const links = (await host.get(`/v1/events/${ev.id}/share-links`)).body;
    const g = (await joinAsGuest(h, links.upload_url.split('/j/')[1], { code: links.join_code })).body;
    const src = await photo(333, { gps: true });
    const up = await guestUpload(h, g, src);
    const row = await h.db.one<any>('SELECT * FROM media WHERE id = $1', [up.mediaId]);
    expect(row.original_key).toBeTruthy();
    expect((await h.storage.getBuffer('media', row.original_key)).equals(src)).toBe(true);        // original kept byte-for-byte (protected)
    await host.post(`/v1/events/${ev.id}/moderation/bulk`, { action: 'approve', media_ids: [up.mediaId] }).expect(200);
    const viewer = (await joinAsGuest(h, links.gallery_url.split('/j/')[1], { code: links.join_code }));
    await host.patch(`/v1/events/${ev.id}`, { join_code_scope: 'both' }).expect(200);
    const gv = (await joinAsGuest(h, links.join_code, {})).body;
    void viewer;
    const guestUrl = h.get<SignedUrlService>(SignedUrlService).mediaUrl(up.mediaId!, 'original', 'pub').replace('http://localhost:4000', '');
    await h.http().get(guestUrl).expect(403);                                                       // original is never served without download + host permission
    const hostUrl = h.get<SignedUrlService>(SignedUrlService).mediaUrl(up.mediaId!, 'original', 'stf').replace('http://localhost:4000', '');
    await h.http().get(hostUrl).expect(404);                                                        // staff audience cannot fetch originals inline either
    await h.http().get(`/v1/guest/media/${up.mediaId}/download-link?variant=original`).set('Authorization', `Bearer ${gv.token}`).expect(403);
    await host.patch(`/v1/events/${ev.id}`, { allow_original_download: true }).expect(200);
    const dl = await h.http().get(`/v1/guest/media/${up.mediaId}/download-link?variant=original`).set('Authorization', `Bearer ${gv.token}`).expect(200);
    expect(dl.body.filename).toMatch(/\.jpg$/);
    const ex = (await host.post(`/v1/events/${ev.id}/exports`, { scope: 'full', variant: 'original' }).expect(200)).body;
    await h.get<ExportsService>(ExportsService).build(ex.id);
    const z = new AdmZip((await h.http().get((await host.get(`/v1/exports/${ex.id}/download`)).body.url.replace('http://localhost:4000', '')).buffer(true).parse(binaryParser)).body as Buffer);
    expect(z.getEntries()[0].getData().equals(src)).toBe(true);
  });
});

describe('Privacy and data-subject rights (acceptance #20, #21)', () => {
  it('guest removal request: auditable workflow with SLA, status via one-time token, photo flagged for review; no auth needed', async () => {
    const host = await Client_.host(h);
    const { ev, ids } = await seed(host, 2);
    await host.post(`/v1/events/${ev.id}/moderation/bulk`, { action: 'approve', media_ids: ids }).expect(200);
    const viewer = (await joinAsGuest(h, ev.galleryToken, { code: ev.joinCode })).status;           // gallery needs its own credential here
    expect(viewer).toBe(401);
    await host.patch(`/v1/events/${ev.id}`, { gallery_access_mode: 'view_only' }).expect(200);
    const v = (await joinAsGuest(h, ev.galleryToken)).body;
    const req = await h.http().post('/v1/privacy/requests').set('Authorization', `Bearer ${v.token}`).send({ type: 'removal', media_id: ids[0], details: 'That is me, please remove it' }).expect(200);
    expect(req.body.ref).toMatch(/^RR-[A-Z0-9]{10}$/);
    expect(new Date(req.body.due_at).getTime()).toBeGreaterThan(Date.now());
    expect((await h.db.one<any>('SELECT moderation_state FROM media WHERE id = $1', [ids[0]])).moderation_state).toBe('flagged');   // hidden pending review
    const mine = await h.http().get(`/v1/privacy/requests/${req.body.ref}`).set('X-Request-Token', req.body.access_token).expect(200);
    expect(mine.body).toMatchObject({ type: 'removal', state: 'received' });
    expect(mine.body.timeline).toEqual([]);
    await h.http().get(`/v1/privacy/requests/${req.body.ref}`).set('X-Request-Token', 'wrong').expect(404);
    await h.http().get(`/v1/privacy/requests/${req.body.ref}`).expect(404);
    await h.http().get('/v1/privacy/requests/RR-NOTEXISTS00').set('X-Request-Token', req.body.access_token).expect(404);
    const row = await h.db.one<any>('SELECT * FROM rights_requests WHERE ref = $1', [req.body.ref]);
    expect(row.access_token_hash).not.toBe(req.body.access_token);                                  // only a hash is stored
    expect(await h.db.one(`SELECT 1 FROM audit_events WHERE action = 'rights.request_created' AND resource_id = $1`, [row.id])).toBeTruthy();

    // staff workflow: identity verification -> in progress -> completed with deletion job; every step audited
    const support = await Staff.create(h, 'support_agent'); const admin = await Staff.create(h, 'super_admin');
    const list = await support.get('/v1/admin/compliance/rights-requests?state=received').expect(200);
    expect(list.body.map((r: any) => r.ref)).toContain(req.body.ref);
    await support.post(`/v1/admin/compliance/rights-requests/${row.id}/advance`, { to: 'completed' }).expect(409);       // cannot skip steps
    await support.post(`/v1/admin/compliance/rights-requests/${row.id}/advance`, { to: 'identity_verification', note: 'asked requester to confirm via event host' }).expect(200);
    await support.post(`/v1/admin/compliance/rights-requests/${row.id}/advance`, { to: 'in_progress' }).expect(200);
    await support.post(`/v1/admin/compliance/rights-requests/${row.id}/advance`, { to: 'completed', note: 'removed', actions: { delete_media: true } }).expect(403);   // erasure needs super admin
    const done = await admin.post(`/v1/admin/compliance/rights-requests/${row.id}/advance`, { to: 'completed', note: 'photo removed at requester request', actions: { delete_media: true } }).expect(200);
    expect(done.body.deletion_jobs).toHaveLength(1);
    const tl = await h.http().get(`/v1/privacy/requests/${req.body.ref}`).set('X-Request-Token', req.body.access_token).expect(200);
    expect(tl.body.state).toBe('completed'); expect(tl.body.timeline.map((t: any) => t.step)).toEqual(['identity_verification', 'in_progress', 'completed']);
    const jobs = await admin.get('/v1/admin/compliance/deletion-jobs?status=pending').expect(200);
    expect(jobs.body.length).toBeGreaterThan(0);
    const run = await h.get<DeletionService>(DeletionService).runDue();
    expect(run.completed).toBeGreaterThanOrEqual(1);
    expect(await h.db.one('SELECT 1 FROM media WHERE id = $1', [ids[0]])).toBeNull();
    expect(await h.storage.head('media', `e/${ev.id}/m/${ids[0]}/thumb.jpg`)).toBeNull();
    const actions = (await admin.get(`/v1/admin/audit?resource_type=rights_request&resource_id=${row.id}`).expect(200)).body.map((a: any) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['rights.request_created', 'rights.identity_verification', 'rights.in_progress', 'rights.completed']));
    const dj = await h.db.one<any>(`SELECT * FROM deletion_jobs WHERE rights_request_id = $1`, [row.id]);
    expect(dj.status).toBe('completed'); expect(dj.evidence.objects_deleted).toBeGreaterThanOrEqual(3);
  });

  it('consent withdrawal is recorded and stops further uploads; access report lists what is held; policies are served in en/am', async () => {
    const host = await Client_.host(h);
    const { ev, g } = await seed(host, 1);
    const w = await h.http().post('/v1/privacy/requests').set('Authorization', `Bearer ${g.token}`).send({ type: 'consent_withdrawal' }).expect(200);
    const consents = await h.db.many<any>(`SELECT action, withdrawn_at FROM consent_records WHERE event_id = $1 ORDER BY created_at`, [ev.id]);
    expect(consents.map((c) => c.action)).toEqual(['granted', 'withdrawn']);
    expect(consents[0].withdrawn_at).not.toBeNull();
    await h.http().post('/v1/guest/uploads/intents').set('Authorization', `Bearer ${g.token}`).send({ mime: 'image/jpeg', size: 100 }).expect(403);
    const admin = await Staff.create(h, 'super_admin');
    const row = await h.db.one<any>('SELECT id FROM rights_requests WHERE ref = $1', [w.body.ref]);
    const report = await admin.get(`/v1/admin/compliance/rights-requests/${row.id}/access-report`).expect(200);
    expect(report.body.subject).toBe('guest_session'); expect(report.body.consents.length).toBe(2); expect(report.body.uploads.length).toBe(1);
    expect(JSON.stringify(report.body)).not.toMatch(/phone_hash|token_hash/);
    expect(await h.db.one(`SELECT 1 FROM audit_events WHERE action = 'rights.access_report_generated'`)).toBeTruthy();
    const en = await h.http().get('/v1/policies/guest_notice?lang=en').expect(200);
    const am = await h.http().get('/v1/policies/guest_notice?lang=am').expect(200);
    expect(en.body.body).toMatch(/facial recognition/i); expect(am.body.body).toMatch(/የፊት ለይቶ ማወቂያ/);
    expect(am.body.legal_status).toBe('draft_pending_legal_review');                                  // legal text is flagged, not silently final
    await h.http().get('/v1/policies/nothing').expect(404);
  });

  it('host account erasure request flows to a deletion job that refuses while the user still owns events', async () => {
    const host = await Client_.host(h);
    await createEvent(h, host);
    const r = await host.post('/v1/privacy/requests', { type: 'erasure', requester_kind: 'host' }).expect(200);
    const row = await h.db.one<any>('SELECT * FROM rights_requests WHERE ref = $1', [r.body.ref]);
    expect(row.user_id).toBe(host.userId);
    const admin = await Staff.create(h, 'super_admin');
    await admin.post(`/v1/admin/compliance/rights-requests/${row.id}/advance`, { to: 'in_progress' }).expect(200);
    await admin.post(`/v1/admin/compliance/rights-requests/${row.id}/advance`, { to: 'completed', actions: { erase_user: true } }).expect(200);
    const run = await h.get<DeletionService>(DeletionService).runDue();
    expect(run.failed).toBe(1);                                                                       // owns an active event -> must delete/transfer first
    expect((await h.db.one<any>(`SELECT status, last_error FROM deletion_jobs WHERE rights_request_id = $1`, [row.id]))).toMatchObject({ status: 'failed' });
  });

  it('rights request intake is rate limited per IP', async () => {
    let last = 0;
    for (let i = 0; i < 12; i++) last = (await h.http().post('/v1/privacy/requests').send({ type: 'access', details: 'x' })).status;
    expect(last).toBe(429);
  });
});
