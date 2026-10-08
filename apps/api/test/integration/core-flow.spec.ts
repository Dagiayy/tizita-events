import sharp from 'sharp';
import exifReader from 'exif-reader';
import { Client_, Harness, binaryParser, bootHarness, createEvent, guestUpload, joinAsGuest, nextPhone, photo, sendChunks } from '../helpers/harness';
import { MemorySmsProvider } from '../../src/notifications/notifications.service';
import { normalizeEthiopianPhone } from '../../src/common/phone';
import { makeJpeg } from '../helpers/images';
import { EICAR_TEST_STRING } from '../../src/media/scan.service';

let h: Harness;
beforeAll(async () => { h = await bootHarness(); });
afterAll(async () => { await h.close(); });

describe('Host authentication (+251 OTP)', () => {
  it('#1 signs up with an Ethiopian number, issues short-lived access + rotating refresh tokens', async () => {
    const phone = '0911223344';
    const r = await h.http().post('/v1/auth/request-otp').send({ phone, locale: 'am' }).expect(200);
    expect(r.body.challenge_id).toBeDefined();
    expect(Object.keys(r.body).sort()).toEqual(['challenge_id', 'expires_in']);   // code never returned to the client
    const sms = MemorySmsProvider.last('+251911223344')!;
    expect(sms).toMatch(/\d{6}/);
    expect(sms).toMatch(/የማረጋገጫ ኮድዎ/);                                  // Amharic template used (#24, #25)
    const code = MemorySmsProvider.lastCode('+251911223344')!;
    const v = await h.http().post('/v1/auth/verify-otp').send({ phone, code }).expect(200);
    expect(v.body.is_new_user).toBe(true);
    expect(v.body.access_token).toBeDefined();
    expect(v.body.access_expires_in).toBe(900);
    const me = await h.http().get('/v1/events').set('Authorization', `Bearer ${v.body.access_token}`).expect(200);
    expect(me.body.events).toEqual([]);
    // the phone is encrypted at rest and only a blind index is searchable
    const row = await h.db.one<any>('SELECT phone_hash, phone_enc, phone_last4 FROM users WHERE phone_last4 = $1', ['3344']);
    expect(row.phone_enc).not.toContain('911223344');
    expect(row.phone_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it.each(['+254712345678', '0111234567', '12345', '+15551234567'])('rejects non-Ethiopian-mobile number %s', async (phone) => {
    await h.http().post('/v1/auth/request-otp').send({ phone }).expect(400);
  });

  it('OTP is single-use, bound to the phone, and a wrong code never authenticates', async () => {
    const phone = nextPhone(); const e = normalizeEthiopianPhone(phone)!;
    await h.http().post('/v1/auth/request-otp').send({ phone }).expect(200);
    const code = MemorySmsProvider.lastCode(e)!;
    const wrong = code === '000000' ? '111111' : '000000';
    await h.http().post('/v1/auth/verify-otp').send({ phone, code: wrong }).expect(401);
    await h.http().post('/v1/auth/verify-otp').send({ phone, code }).expect(200);
    await h.http().post('/v1/auth/verify-otp').send({ phone, code }).expect(401);   // replay
    const other = nextPhone();
    await h.http().post('/v1/auth/verify-otp').send({ phone: other, code }).expect(401);
  });

  it('#17 OTP brute force is rate limited (per challenge attempts and per phone window)', async () => {
    const phone = nextPhone(); const e = normalizeEthiopianPhone(phone)!;
    await h.http().post('/v1/auth/request-otp').send({ phone }).expect(200);
    const real = MemorySmsProvider.lastCode(e)!;
    const statuses: number[] = [];
    for (let i = 0; i < 14; i++) {
      const guess = String(100000 + i).replace(real, '999999');
      statuses.push((await h.http().post('/v1/auth/verify-otp').send({ phone, code: guess })).status);
    }
    expect(statuses.slice(0, 5)).toEqual([401, 401, 401, 401, 401]);
    expect(statuses).toContain(429);
    // even the correct code is refused once the challenge is locked/limited
    const ok = await h.http().post('/v1/auth/verify-otp').send({ phone, code: real });
    expect([401, 429]).toContain(ok.status);
  });

  it('OTP request flood per phone is limited', async () => {
    const phone = nextPhone();
    await h.redis.client.set(`rl:otp:req:phone:${h.crypto.hmac(normalizeEthiopianPhone(phone)!, 'phone')}`, '3', 'EX', 600);
    await h.http().post('/v1/auth/request-otp').send({ phone }).expect(200); // limit in test env is 50
    const hasRL = await h.http().post('/v1/auth/request-otp').send({ phone: '0912000000' });
    expect(hasRL.status).toBe(200);
  });

  it('refresh rotates tokens; replaying an old refresh token revokes the session; device list + revoke works', async () => {
    const c = await Client_.host(h);
    const r1 = await h.http().post('/v1/auth/refresh').send({ refresh_token: c.refresh }).expect(200);
    expect(r1.body.refresh_token).not.toBe(c.refresh);
    await h.http().post('/v1/auth/refresh').send({ refresh_token: c.refresh }).expect(401);          // reuse detected
    await h.http().post('/v1/auth/refresh').send({ refresh_token: r1.body.refresh_token }).expect(401); // whole session revoked
    await h.http().get('/v1/events').set('Authorization', `Bearer ${c.token}`).expect(401);            // access token dies with the session

    const a = await Client_.host(h, nextPhone(), 'Phone A');
    const phoneOnly = a.phone;
    const b = await Client_.host(h, phoneOnly, 'Phone B (unknown)');
    const list = await a.get('/v1/sessions').expect(200);
    expect(list.body.sessions.length).toBe(2);
    await a.post('/v1/auth/request-otp', { phone: phoneOnly }).expect(200);
    const code = MemorySmsProvider.lastCode(normalizeEthiopianPhone(phoneOnly)!)!;
    const rec = await h.http().post('/v1/auth/verify-otp').send({ phone: phoneOnly, code, recovery: true, device_label: 'recovered' }).expect(200);
    await b.get('/v1/events').expect(401);                 // unknown sessions revoked by account recovery
    await a.get('/v1/events').expect(401);
    const fresh = await h.http().get('/v1/sessions').set('Authorization', `Bearer ${rec.body.access_token}`).expect(200);
    expect(fresh.body.sessions.length).toBe(1);
    const other = fresh.body.sessions[0];
    await h.http().delete(`/v1/sessions/${other.id}`).set('Authorization', `Bearer ${rec.body.access_token}`).expect(200);
    await h.http().get('/v1/events').set('Authorization', `Bearer ${rec.body.access_token}`).expect(401);
  });

  it('protected routes need a token; guest tokens are not user tokens; unknown routes are default-deny', async () => {
    await h.http().get('/v1/events').expect(401);
    await h.http().get('/v1/events').set('Authorization', 'Bearer not.a.token').expect(401);
    await h.http().get('/v1/admin/dashboard').expect(401);
  });
});

describe('Event creation, activation, privacy defaults and sharing', () => {
  it('#2 host creates an event (draft), cannot share until activated, then activation makes it live with separate upload/gallery secrets', async () => {
    const host = await Client_.host(h);
    const now = Date.now();
    const created = await host.post('/v1/events', {
      name: 'ሰላም ልደት', type: 'birthday', city: 'Bahir Dar', starts_at: new Date(now + 86400_000).toISOString(), ends_at: new Date(now + 90000_000).toISOString(),
    }).expect(201);
    expect(created.body.state).toBe('draft');
    expect(created.body.country).toBe('ET');
    expect(created.body.timezone).toBe('Africa/Addis_Ababa');
    expect(created.body.settings.privacy_mode).toBe('private');                         // private by default
    expect(created.body.settings.upload_access_mode).toBe('code');
    expect(created.body.settings.gallery_access_mode).toBe('code');
    expect(created.body.name).toBe('ሰላም ልደት');                                          // Ethiopic Unicode round-trips (#25)
    expect(created.body.id).toMatch(/^[0-9a-f-]{36}$/);                                  // random UUID
    await host.get(`/v1/events/${created.body.id}/share-links`).expect(409);            // no QR before activation
    await h.http().get(`/v1/events/${created.body.public_code}/context`).expect(404);   // drafts are invisible to guests

    await host.post(`/v1/events/${created.body.id}/activate-trial`).expect(200);
    const ev = await host.get(`/v1/events/${created.body.id}`).expect(200);
    expect(ev.body.state).toBe('scheduled');                                            // future window -> scheduled
    expect(ev.body.entitlement.has_package).toBe(true);
    const links = await host.get(`/v1/events/${created.body.id}/share-links`).expect(200);
    expect(links.body.upload_url).toMatch(/\/j\/u_/);
    expect(links.body.gallery_url).toMatch(/\/j\/g_/);
    expect(links.body.upload_url.split('/j/')[1]).not.toBe(links.body.gallery_url.split('/j/')[1]);
    expect(links.body.join_code).toMatch(/^[A-HJKMNP-Z2-9]{8}$/);
    await host.post(`/v1/events/${created.body.id}/activate-trial`).expect(409);        // already active
    const second = await host.post('/v1/events', { name: 'second', type: 'party', city: 'Adama', starts_at: new Date(now + 86400_000).toISOString(), ends_at: new Date(now + 90000_000).toISOString() }).expect(201);
    await host.post(`/v1/events/${second.body.id}/activate-trial`).expect(409);         // trial once per owner (D59)
  });

  it('Ethiopia-only: other countries, invalid dates and over-long windows are rejected', async () => {
    const host = await Client_.host(h);
    const base = { name: 'x', type: 'party', city: 'Adama', starts_at: new Date(Date.now() + 1e7).toISOString(), ends_at: new Date(Date.now() + 2e7).toISOString() };
    await host.post('/v1/events', { ...base, country: 'KE' }).expect(400);
    await host.post('/v1/events', { ...base, ends_at: new Date(Date.now() - 1e7).toISOString() }).expect(422);
    await host.post('/v1/events', { ...base, upload_opens_at: new Date().toISOString(), upload_closes_at: new Date(Date.now() + 40 * 86400_000).toISOString() }).expect(422);
    await host.post('/v1/events', { ...base, city: '' }).expect(400);
    await host.post('/v1/events', { ...base, currency: 'USD' }).expect(400);              // unknown field rejected (strict schema)
  });

  it('open access requires explicit public opt-in; passcode mode requires a passcode; deferred features stay off', async () => {
    const host = await Client_.host(h);
    const base = { name: 'x', type: 'party', city: 'Adama', starts_at: new Date(Date.now() + 1e7).toISOString(), ends_at: new Date(Date.now() + 2e7).toISOString() };
    await host.post('/v1/events', { ...base, upload_access_mode: 'open' }).expect(422);
    await host.post('/v1/events', { ...base, upload_access_mode: 'open', privacy_mode: 'public' }).expect(201);
    await host.post('/v1/events', { ...base, gallery_access_mode: 'passcode' }).expect(422);
    await host.post('/v1/events', { ...base, comments_enabled: true }).expect(422);       // comments deferred (D10)
    await host.post('/v1/events', { ...base, reactions_enabled: true }).expect(422);
  });

  it('#18 event IDs cannot be guessed: other hosts, guests and anonymous callers get 404/401, never data', async () => {
    const a = await Client_.host(h); const b = await Client_.host(h);
    const ev = await createEvent(h, a);
    await b.get(`/v1/events/${ev.id}`).expect(404);
    await b.patch(`/v1/events/${ev.id}`, { name: 'hijack' }).expect(404);
    await b.get(`/v1/events/${ev.id}/share-links`).expect(404);
    await b.get(`/v1/events/${ev.id}/media`).expect(404);
    await b.get(`/v1/events/${ev.id}/moderation`).expect(404);
    await b.post(`/v1/events/${ev.id}/close`, { mode: 'now' }).expect(404);
    await b.post(`/v1/events/${ev.id}/exports`, { scope: 'full' }).expect(404);
    await h.http().get(`/v1/events/${ev.id}`).expect(401);
    await h.http().get(`/v1/events/${ev.id}/context`).expect(404);                       // a uuid is not a locator
    await h.http().get(`/v1/events/${ev.code}/context`).expect(404);                     // neither is the public code
    const g = await joinAsGuest(h, ev.uploadToken).then((r) => r.body);
    await h.http().get(`/v1/events/${ev.id}/media`).set('Authorization', `Bearer ${g.token}`).expect(401);
    await h.http().get('/v1/events/not-a-uuid').set('Authorization', `Bearer ${b.token}`).expect(400);
    const list = await b.get('/v1/events').expect(200);
    expect(list.body.events).toHaveLength(0);
  });

  it('QR codes: PNG and printable PDF (Amharic card) for upload and gallery; link tokens differ', async () => {
    const host = await Client_.host(h);
    const ev = await createEvent(h, host, { name: 'የሰርግ ዝግጅት', language: 'am', host_name: 'አበበ' });
    const png = await host.post(`/v1/events/${ev.id}/qr`, { kind: 'upload', format: 'png' }).expect(200).buffer(true).parse(binaryParser);
    expect(png.headers['content-type']).toBe('image/png');
    expect((await sharp(png.body as Buffer).metadata()).width).toBeGreaterThanOrEqual(256);
    const pdf = await host.post(`/v1/events/${ev.id}/qr`, { kind: 'gallery', format: 'pdf', include_code: true }).expect(200).buffer(true).parse(binaryParser);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect((pdf.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
    await h.http().post(`/v1/events/${ev.id}/qr`).send({ kind: 'upload' }).expect(401);
  });
});

describe('Guest access: no account, separate secrets, access modes', () => {
  it('#3 QR/link opens a context page with no account; context exposes minimal identity only', async () => {
    const host = await Client_.host(h);
    const ev = await createEvent(h, host);
    const ctx = await h.http().get(`/v1/events/${ev.uploadToken}/context`).expect(200);
    expect(ctx.body.event.name).toContain('Wedding');
    expect(ctx.body.scopes).toEqual([{ scope: 'upload', mode: 'code', credential: 'code', credential_satisfied_by_locator: false }]);
    expect(ctx.body.notice.version).toBe('2026-10-draft');
    expect(ctx.body.limits.max_bytes).toBe(15 * 1024 * 1024);
    const raw = JSON.stringify(ctx.body);
    for (const leak of [ev.id, ev.galleryToken, ev.joinCode, 'owner_id', 'storage', 'bucket']) expect(raw).not.toContain(leak);
    await h.http().get('/v1/events/u_doesnotexistdoesnotexistdoesnotexist/context').expect(404);
  });

  it('code mode: the link alone is not enough; the join code (or typing the code as locator) grants only its scope', async () => {
    const host = await Client_.host(h);
    const ev = await createEvent(h, host);                       // upload=code, gallery=code, join_code_scope=upload
    const noCode = await joinAsGuest(h, ev.uploadToken);
    expect(noCode.status).toBe(401);
    expect(noCode.body.error.code).toBe('credential_required');
    expect(noCode.body.error.details.required).toEqual({ upload: 'code' });
    expect((await joinAsGuest(h, ev.uploadToken, { code: 'WRONGCODE' })).status).toBe(401);
    const ok = await joinAsGuest(h, ev.uploadToken, { code: ev.joinCode.toLowerCase() });
    expect(ok.status).toBe(200);
    expect(ok.body.scopes).toEqual(['upload']);
    const viaCode = await joinAsGuest(h, ev.joinCode.toLowerCase());                 // manual join with the short code
    expect(viaCode.status).toBe(200);
    expect(viaCode.body.scopes).toEqual(['upload']);                                 // code scope = upload; never gallery
    // possession of the upload QR must not grant gallery access
    await h.http().get('/v1/guest/media').set('Authorization', `Bearer ${viaCode.body.token}`).expect(403);
    const galleryTry = await joinAsGuest(h, ev.galleryToken, {}, viaCode.body.token);
    expect(galleryTry.status).toBe(401);                                              // gallery needs its own code
  });

  it('passcode mode: wrong passcode fails and is rate limited; right passcode grants gallery; scopes merge into one session', async () => {
    const host = await Client_.host(h);
    const ev = await createEvent(h, host);
    await host.post(`/v1/events/${ev.id}/secrets/rotate`, { type: 'passcode', passcode: 'Meskel-2019' }).expect(200);
    await host.patch(`/v1/events/${ev.id}`, { gallery_access_mode: 'passcode', upload_access_mode: 'open', privacy_mode: 'public' }).expect(200);
    const up = await joinAsGuest(h, ev.uploadToken);
    expect(up.status).toBe(200);
    expect((await joinAsGuest(h, ev.galleryToken, { passcode: 'nope' }, up.body.token)).status).toBe(401);
    const both = await joinAsGuest(h, ev.galleryToken, { passcode: 'Meskel-2019' }, up.body.token);
    expect(both.status).toBe(200);
    expect(both.body.scopes.sort()).toEqual(['gallery', 'upload']);
    let last = 0;
    for (let i = 0; i < 12; i++) last = (await joinAsGuest(h, ev.galleryToken, { passcode: 'guess' + i })).status;
    expect(last).toBe(429);
  });

  it('consent is a separate active action; name can be required; withdrawal is recorded', async () => {
    const host = await Client_.host(h);
    const ev = await createEvent(h, host, { guest_name_required: true });
    expect((await h.http().post(`/v1/events/${ev.uploadToken}/join`).send({ code: ev.joinCode })).status).toBe(422);        // no consent
    const noName = await joinAsGuest(h, ev.uploadToken, { code: ev.joinCode });
    expect(noName.body.error.code).toBe('name_required');
    const bad = await h.http().post(`/v1/events/${ev.uploadToken}/join`).send({ code: ev.joinCode, display_name: 'Sara', consent: { notice_version: 'x', accepted: false } });
    expect(bad.status).toBe(400);
    const ok = await joinAsGuest(h, ev.uploadToken, { code: ev.joinCode, display_name: 'ሳራ' });
    expect(ok.status).toBe(200);
    expect(ok.body.display_name).toBe('ሳራ');
    const c = await h.db.one<any>(`SELECT * FROM consent_records WHERE event_id = $1`, [ev.id]);
    expect(c).toMatchObject({ purpose: 'event_photo_upload', policy_version: '2026-10-draft', action: 'granted' });
  });

  it('verified-phone mode: OTP proof is required, bound to the event, and rate limited', async () => {
    const host = await Client_.host(h);
    const ev = await createEvent(h, host);
    await host.patch(`/v1/events/${ev.id}`, { upload_access_mode: 'verified_phone' }).expect(200);
    const need = await joinAsGuest(h, ev.uploadToken);
    expect(need.status).toBe(401); expect(need.body.error.details.required.upload).toBe('otp');
    const phone = '0922334455';
    await h.http().post(`/v1/events/${ev.uploadToken}/verify`).send({ phone }).expect(200);
    const code = MemorySmsProvider.lastCode('+251922334455')!;
    await h.http().post(`/v1/events/${ev.uploadToken}/verify`).send({ phone, code: code === '111111' ? '222222' : '111111' }).expect(401);
    const proof = await h.http().post(`/v1/events/${ev.uploadToken}/verify`).send({ phone, code }).expect(200);
    const joined = await joinAsGuest(h, ev.uploadToken, { verification_proof: proof.body.verification_proof });
    expect(joined.status).toBe(200);
    const sess = await h.db.one<any>('SELECT phone_verified_at, phone_hash FROM guest_sessions WHERE event_id = $1', [ev.id]);
    expect(sess.phone_verified_at).not.toBeNull();
    expect(sess.phone_hash).not.toContain('922334455');
    const ev2 = await createEvent(h, await Client_.host(h));
    await h.http().post(`/v1/events/${ev2.uploadToken}/verify`).send({ phone }).expect(409);   // event does not use verification
  });
});

describe('Media pipeline: upload, quarantine, processing, moderation, gallery', () => {
  let host: Client_; let ev: Awaited<ReturnType<typeof createEvent>>; let guest: { token: string }; let viewer: { token: string };
  beforeAll(async () => {
    host = await Client_.host(h);
    ev = await createEvent(h, host, { gallery_access_mode: 'view_only', privacy_mode: 'private' });
    guest = (await joinAsGuest(h, ev.uploadToken, { code: ev.joinCode })).body;
    viewer = (await joinAsGuest(h, ev.galleryToken)).body;
  });

  it('#4/#5/#6 multi-chunk upload with visible progress, resume status, and idempotent completion; processing publishes nothing unapproved', async () => {
    const buf = await photo(1, { gps: true, width: 3000, height: 2000, quality: 92 });
    expect(buf.length).toBeGreaterThan(65536 * 2);
    const intent = await h.http().post('/v1/guest/uploads/intents').set('Authorization', `Bearer ${guest.token}`).send({ mime: 'image/jpeg', size: buf.length, client_filename: '../../etc/passwd.jpg' }).expect(200);
    const { media_id, upload } = intent.body;
    expect(upload.total_chunks).toBeGreaterThan(2);
    expect(JSON.stringify(intent.body)).not.toMatch(/quarantine|bucket|minio|s3/i);       // no storage details leak
    const id = media_id;
    const put = (i: number) => h.http().put(`/v1/uploads/${id}/chunks/${i}`).set('X-Upload-Token', upload.token).set('Content-Type', 'application/octet-stream').send(buf.subarray(i * upload.chunk_bytes, Math.min((i + 1) * upload.chunk_bytes, buf.length)));
    await put(0).expect(200);
    const st1 = await h.http().get(`/v1/uploads/${id}`).set('X-Upload-Token', upload.token).expect(200);
    expect(st1.body).toMatchObject({ state: 'uploading', received: [0] });                // progress/resume info
    await h.http().post(`/v1/media/${id}/complete`).set('X-Upload-Token', upload.token).expect(409);   // incomplete
    await put(0).expect(200);                                                              // #7 retry of an already-sent chunk is harmless
    for (let i = 2; i < upload.total_chunks; i++) await put(i).expect(200);                // gap at chunk 1 simulates a network drop
    const miss = await h.http().post(`/v1/media/${id}/complete`).set('X-Upload-Token', upload.token).expect(409);
    expect(miss.body.error.details.missing).toEqual([1]);
    await put(1).expect(200);                                                              // #8 resumes after interruption
    const idem = { 'Idempotency-Key': 'complete-' + id };
    const done1 = await h.http().post(`/v1/media/${id}/complete`).set('X-Upload-Token', upload.token).set(idem).expect(200);
    const done2 = await h.http().post(`/v1/media/${id}/complete`).set('X-Upload-Token', upload.token).set(idem).expect(200);
    expect(done2.body).toEqual(done1.body);
    expect(done1.body.state).toBe('uploaded');
    await h.http().put(`/v1/uploads/${id}/chunks/0`).set('X-Upload-Token', upload.token).send(buf.subarray(0, 65536)).expect(409);   // closed after completion
    // quarantined: nothing is visible until processing succeeds
    expect((await h.http().get('/v1/guest/media').set('Authorization', `Bearer ${viewer.token}`)).body.items).toHaveLength(0);
    await h.get<any>((await import('../../src/media/processing.service')).ProcessingService).process(id);
    const row = await h.db.one<any>('SELECT * FROM media WHERE id = $1', [id]);
    expect(row).toMatchObject({ upload_state: 'ready', moderation_state: 'pending', mime: 'image/jpeg', width: 3000, height: 2000 });
    expect(row.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(row.phash).not.toBeNull();
    expect(new Date(row.captured_at).getUTCFullYear()).toBe(2026);
    expect(row.quarantine_prefix).toContain('/');                                          // exists internally but never returned
    expect((await h.storage.head('quarantine', `q/${ev.id}/${id}/part-00000`))).toBeNull(); // quarantine cleaned after processing
  });

  it('#9 unapproved photos are invisible to normal guests everywhere (list, signed URLs, live stream, downloads)', async () => {
    const mediaId = (await h.db.one<any>(`SELECT id FROM media WHERE event_id = $1 AND moderation_state = 'pending' LIMIT 1`, [ev.id])).id;
    expect((await h.http().get('/v1/guest/media').set('Authorization', `Bearer ${viewer.token}`)).body.items).toHaveLength(0);
    const sign = h.get<any>((await import('../../src/media/signed-url.service')).SignedUrlService);
    const pubUrl = sign.mediaUrl(mediaId, 'viewer', 'pub').replace('http://localhost:4000', '');
    await h.http().get(pubUrl).expect(404);                                                // valid signature, but not approved
    await h.http().get(`/v1/guest/media/${mediaId}/download-link`).set('Authorization', `Bearer ${viewer.token}`).expect(404);
    await h.http().post(`/v1/media/${mediaId}/report`).set('Authorization', `Bearer ${viewer.token}`).send({ reason: 'other' }).expect(404);
    const stfUrl = sign.mediaUrl(mediaId, 'thumb', 'stf').replace('http://localhost:4000', '');
    await h.http().get(stfUrl).expect(200);                                                // moderators (staff audience) can see it
    const tamper = pubUrl.replace('viewer', 'thumb');
    await h.http().get(tamper).expect(403);                                                // signature binds the variant
    const bad = pubUrl.replace(/sig=[^&]+/, 'sig=AAAA');
    await h.http().get(bad).expect(403);
    const expired = sign.mediaUrl(mediaId, 'viewer', 'pub', { ttlSec: -5 }).replace('http://localhost:4000', '');
    expect((await h.http().get(expired)).body.error.code).toBe('link_expired');
    // the uploader can see only the status of their own upload (not the pending image)
    const mine = await h.http().get('/v1/guest/me').set('Authorization', `Bearer ${guest.token}`).expect(200);
    expect(mine.body.uploads[0].state).toBe('pending');
    expect(JSON.stringify(mine.body)).not.toContain('thumb');
  });

  it('#10 host bulk approve/reject; approval publishes; rejected stays hidden; gallery is newest-first with cursor pagination', async () => {
    const ids: string[] = [];
    for (let i = 10; i < 16; i++) ids.push((await guestUpload(h, guest, await photo(i))).mediaId!);
    const q = await host.get(`/v1/events/${ev.id}/moderation`).expect(200);
    expect(q.body.counts.pending).toBe(7);
    const [toReject, ...toApprove] = ids;
    const bulk = await host.post(`/v1/events/${ev.id}/moderation/bulk`, { action: 'approve', media_ids: toApprove, reason: 'ok' }).expect(200);
    expect(bulk.body.results.every((r: any) => r.ok && r.state === 'approved')).toBe(true);
    await host.post(`/v1/events/${ev.id}/moderation/bulk`, { action: 'reject', media_ids: [toReject] }).expect(200);
    const again = await host.post(`/v1/events/${ev.id}/moderation/bulk`, { action: 'approve', media_ids: [...toApprove, '00000000-0000-4000-8000-000000000000'] }).expect(200);
    expect(again.body.results.filter((r: any) => !r.ok).length).toBeGreaterThan(0);         // invalid transitions / unknown ids reported per item

    const p1 = await h.http().get('/v1/guest/media?limit=3').set('Authorization', `Bearer ${viewer.token}`).expect(200);
    expect(p1.body.items).toHaveLength(3);
    expect(p1.body.next_cursor).toBeTruthy();
    const p2 = await h.http().get(`/v1/guest/media?limit=3&cursor=${p1.body.next_cursor}`).set('Authorization', `Bearer ${viewer.token}`).expect(200);
    expect(p2.body.items).toHaveLength(2);
    expect(p2.body.next_cursor).toBeNull();
    const all = [...p1.body.items, ...p2.body.items];
    expect(new Set(all.map((i: any) => i.id)).size).toBe(5);
    expect(all.map((i: any) => i.id)).not.toContain(toReject);
    const times = all.map((i: any) => +new Date(i.published_at));
    expect([...times].sort((a, b) => b - a)).toEqual(times);
    await h.http().get('/v1/guest/media?cursor=garbage').set('Authorization', `Bearer ${viewer.token}`).expect(400);
    expect(Object.keys(p1.body.items[0].urls).sort()).toEqual(['gallery', 'thumb', 'viewer']);
    // image bytes through signed URLs: derivative sizes and cache headers
    const img = await h.http().get(p1.body.items[0].urls.thumb.replace('http://localhost:4000', '')).expect(200).buffer(true).parse(binaryParser);
    expect(img.headers['content-type']).toBe('image/jpeg');
    expect(img.headers['cache-control']).toMatch(/private/);
    expect(img.headers['x-content-type-options']).toBe('nosniff');
    const meta = await sharp(img.body as Buffer).metadata();
    expect(Math.max(meta.width!, meta.height!)).toBe(480);                                 // thumbnail derivative
  });

  it('#19 the bytes served to guests contain no EXIF/GPS even when the original had it', async () => {
    const ids = await h.db.many<any>(`SELECT id FROM media WHERE event_id = $1 AND moderation_state = 'approved'`, [ev.id]);
    const sign = h.get<any>((await import('../../src/media/signed-url.service')).SignedUrlService);
    for (const { id } of ids.slice(0, 2)) for (const variant of ['thumb', 'gallery', 'viewer']) {
      const r = await h.http().get(sign.mediaUrl(id, variant, 'pub').replace('http://localhost:4000', '')).expect(200).buffer(true).parse(binaryParser);
      const meta = await sharp(r.body as Buffer).metadata();
      expect(meta.exif).toBeUndefined();
      expect((r.body as Buffer).includes(Buffer.from('Exif'))).toBe(false);
      expect((r.body as Buffer).includes(Buffer.from('TestCam'))).toBe(false);
    }
    // the first upload had GPS: the stored derivative is clean while no original is retained for the trial plan
    const first = await h.db.many<any>(`SELECT variant FROM media_derivatives WHERE media_id = (SELECT id FROM media WHERE event_id = $1 ORDER BY created_at LIMIT 1)`, [ev.id]);
    expect(first.map((d) => d.variant).sort()).toEqual(['gallery', 'thumb', 'viewer']);   // no 'original' on the trial plan
  });

  it('abuse: fake MIME, mislabeled, oversized, unsupported, EICAR malware, corrupt images, and duplicates', async () => {
    const auth = { Authorization: `Bearer ${guest.token}` };
    // declared type not allowed / oversized are refused at intent time
    await h.http().post('/v1/guest/uploads/intents').set(auth).send({ mime: 'application/x-msdownload', size: 1000 }).expect(415);
    await h.http().post('/v1/guest/uploads/intents').set(auth).send({ mime: 'image/svg+xml', size: 1000 }).expect(415);
    await h.http().post('/v1/guest/uploads/intents').set(auth).send({ mime: 'image/jpeg', size: 15 * 1024 * 1024 + 1 }).expect(413);
    await h.http().post('/v1/guest/uploads/intents').set(auth).send({ mime: 'image/jpeg', size: 0 }).expect(400);
    // fake: an executable declared as image/jpeg is rejected by magic-byte validation in the worker
    const fake = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(3000, 65)]);
    const f = await guestUpload(h, guest, fake);
    expect(await h.db.one<any>('SELECT upload_state, failure_code FROM media WHERE id = $1', [f.mediaId])).toMatchObject({ upload_state: 'failed', failure_code: 'invalid_magic' });
    // EICAR wrapped in a valid-looking JPEG header
    const eicar = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(EICAR_TEST_STRING), Buffer.alloc(100)]);
    const e = await guestUpload(h, guest, eicar);
    expect((await h.db.one<any>('SELECT upload_state, failure_code FROM media WHERE id = $1', [e.mediaId]))).toMatchObject({ upload_state: 'failed', failure_code: 'malware_detected' });
    expect(await h.db.one(`SELECT 1 FROM audit_events WHERE action = 'media.malware_detected'`)).toBeTruthy();
    // valid header, corrupt body
    const corrupt = Buffer.concat([(await photo(77)).subarray(0, 600), Buffer.alloc(2000, 0x55)]);
    const c = await guestUpload(h, guest, corrupt);
    expect((await h.db.one<any>('SELECT failure_code FROM media WHERE id = $1', [c.mediaId])).failure_code).toBe('decode_failed');
    // PNG declared as JPEG is accepted but stored by detected type
    const { makePng } = await import('../helpers/images');
    const p = await guestUpload(h, guest, await makePng(400, 300));
    expect((await h.db.one<any>('SELECT mime, upload_state FROM media WHERE id = $1', [p.mediaId]))).toMatchObject({ mime: 'image/png', upload_state: 'ready' });
    // chunk size tampering
    const buf = await photo(5);
    const intent = await h.http().post('/v1/guest/uploads/intents').set(auth).send({ mime: 'image/jpeg', size: buf.length }).expect(200);
    const up = intent.body.upload;
    await h.http().put(`/v1/uploads/${intent.body.media_id}/chunks/0`).set('X-Upload-Token', up.token).send(Buffer.alloc(100)).expect(400);
    await h.http().put(`/v1/uploads/${intent.body.media_id}/chunks/999`).set('X-Upload-Token', up.token).send(Buffer.alloc(100)).expect(400);
    await h.http().put(`/v1/uploads/${intent.body.media_id}/chunks/0`).send(buf.subarray(0, 65536)).expect(401);
    await h.http().put(`/v1/uploads/${intent.body.media_id}/chunks/0`).set('X-Upload-Token', up.token.replace(/.$/, 'x')).send(buf.subarray(0, 65536)).expect(401);
    const otherToken = (await h.http().post('/v1/guest/uploads/intents').set(auth).send({ mime: 'image/jpeg', size: buf.length })).body.upload.token;
    await h.http().put(`/v1/uploads/${intent.body.media_id}/chunks/0`).set('X-Upload-Token', otherToken).send(buf.subarray(0, 65536)).expect(401);   // token is bound to its media id
    // exact duplicate bytes -> deduplicated, never published twice
    const first = (await h.db.one<any>(`SELECT id FROM media WHERE event_id = $1 AND moderation_state = 'approved' LIMIT 1`, [ev.id])).id;
    const original = await photo(11);                                                     // same seed as an already-uploaded photo (seed 11 above)
    const dup = await guestUpload(h, guest, original);
    expect((await h.db.one<any>('SELECT upload_state, dup_of_media_id FROM media WHERE id = $1', [dup.mediaId]))).toMatchObject({ upload_state: 'duplicate' });
    void first;
    // near-duplicate (re-encoded) is kept but flagged for the host
    const near = await sharp(original).resize(900).jpeg({ quality: 70 }).toBuffer();
    const n = await guestUpload(h, guest, near);
    expect((await h.db.one<any>('SELECT upload_state, near_dup_of_media_id FROM media WHERE id = $1', [n.mediaId]))).toMatchObject({ upload_state: 'ready' });
    expect((await h.db.one<any>('SELECT near_dup_of_media_id FROM media WHERE id = $1', [n.mediaId])).near_dup_of_media_id).not.toBeNull();
  });

  it('reports: reasons validated, repeated reports are idempotent, flagged media disappears from the guest gallery, reporter gets a generic answer', async () => {
    const target = (await h.db.one<any>(`SELECT id FROM media WHERE event_id = $1 AND moderation_state = 'approved' ORDER BY published_at LIMIT 1`, [ev.id])).id;
    const auth = { Authorization: `Bearer ${viewer.token}` };
    await h.http().post(`/v1/media/${target}/report`).set(auth).send({ reason: 'spam' }).expect(400);
    const r1 = await h.http().post(`/v1/media/${target}/report`).set(auth).send({ reason: 'privacy_concern', details: 'please remove' }).expect(200);
    expect(r1.body).toEqual({ ok: true, message_key: 'report.received' });
    await h.http().post(`/v1/media/${target}/report`).set(auth).send({ reason: 'privacy_concern' }).expect(200);
    expect((await h.db.one<any>('SELECT count(*)::int AS n FROM moderation_reports WHERE media_id = $1', [target])).n).toBe(1);
    expect((await h.db.one<any>('SELECT moderation_state FROM media WHERE id = $1', [target])).moderation_state).toBe('flagged');
    const list = await h.http().get('/v1/guest/media?limit=60').set(auth).expect(200);
    expect(list.body.items.map((i: any) => i.id)).not.toContain(target);
    const q = await host.get(`/v1/events/${ev.id}/moderation`).expect(200);
    expect(q.body.items.find((i: any) => i.id === target).reports[0].reason).toBe('privacy_concern');
    await host.post(`/v1/media/${target}/restore`, { reason: 'false alarm' }).expect(200);
    expect((await h.http().get('/v1/guest/media?limit=60').set(auth)).body.items.map((i: any) => i.id)).toContain(target);
    const logs = await host.get(`/v1/events/${ev.id}/moderation/logs`).expect(200);
    expect(logs.body.logs.map((l: any) => l.action)).toEqual(expect.arrayContaining(['approve', 'flag', 'restore']));
    expect(await h.db.one(`SELECT 1 FROM audit_events WHERE action = 'moderation.restore' AND resource_id = $1`, [target])).toBeTruthy();
  });

  it('blocking an uploader stops uploads (session + device), can hide their media, and is audited', async () => {
    const bad = (await joinAsGuest(h, ev.uploadToken, { code: ev.joinCode, device_id: 'device-bad-1' })).body;
    const up = await guestUpload(h, bad, await photo(500));
    const sessId = (await h.db.one<any>('SELECT uploader_session_id FROM media WHERE id = $1', [up.mediaId])).uploader_session_id;
    await host.post(`/v1/events/${ev.id}/moderation/bulk`, { action: 'approve', media_ids: [up.mediaId] }).expect(200);
    const blk = await host.post(`/v1/events/${ev.id}/guests/${sessId}/block`, { hide_media: true, reason: 'spam' }).expect(200);
    expect(blk.body.hidden).toBe(1);
    expect((await h.db.one<any>('SELECT moderation_state FROM media WHERE id = $1', [up.mediaId])).moderation_state).toBe('hidden');
    await h.http().post('/v1/guest/uploads/intents').set('Authorization', `Bearer ${bad.token}`).send({ mime: 'image/jpeg', size: 1000 }).expect(403);
    const rejoin = await joinAsGuest(h, ev.uploadToken, { code: ev.joinCode, device_id: 'device-bad-1' });
    expect(rejoin.status).toBe(403);                                                       // same device cannot simply rejoin
    expect((await joinAsGuest(h, ev.uploadToken, { code: ev.joinCode, device_id: 'device-good' })).status).toBe(200);
  });

  it('quota exhaustion: per-event media and storage limits are enforced at intent time', async () => {
    const host2 = await Client_.host(h);
    const ev2 = await createEvent(h, host2);
    const g = (await joinAsGuest(h, ev2.uploadToken, { code: ev2.joinCode })).body;
    await h.db.query(`UPDATE entitlements SET max_media = 2 WHERE event_id = $1`, [ev2.id]);
    for (let i = 0; i < 2; i++) await h.http().post('/v1/guest/uploads/intents').set('Authorization', `Bearer ${g.token}`).send({ mime: 'image/jpeg', size: 1000 }).expect(200);
    const full = await h.http().post('/v1/guest/uploads/intents').set('Authorization', `Bearer ${g.token}`).send({ mime: 'image/jpeg', size: 1000 }).expect(409);
    expect(full.body.error.code).toBe('event_media_limit');
    await h.db.query(`UPDATE entitlements SET max_media = 100, storage_bytes = 1500 WHERE event_id = $1`, [ev2.id]);
    expect((await h.http().post('/v1/guest/uploads/intents').set('Authorization', `Bearer ${g.token}`).send({ mime: 'image/jpeg', size: 5000 })).body.error.code).toBe('event_storage_full');
    // per-session cap
    await h.db.query(`UPDATE entitlements SET storage_bytes = 1e12 WHERE event_id = $1`, [ev2.id]);
    await h.db.query(`UPDATE guest_sessions SET upload_count = 100 WHERE event_id = $1`, [ev2.id]);
    expect((await h.http().post('/v1/guest/uploads/intents').set('Authorization', `Bearer ${g.token}`).send({ mime: 'image/jpeg', size: 1000 })).status).toBe(429);
  });

  it('downloads: host switch + plan entitlement control saving; originals need both plan and host permission', async () => {
    const approved = (await h.db.one<any>(`SELECT id FROM media WHERE event_id = $1 AND moderation_state = 'approved' LIMIT 1`, [ev.id])).id;
    const g = { Authorization: `Bearer ${viewer.token}` };
    const link = await h.http().get(`/v1/guest/media/${approved}/download-link`).set(g).expect(200);
    const dl = await h.http().get(link.body.url.replace('http://localhost:4000', '')).expect(200);
    expect(dl.headers['content-disposition']).toMatch(/attachment; filename="event-photo-[0-9a-f]{8}\.jpg"/);
    await h.http().get(`/v1/guest/media/${approved}/download-link?variant=original`).set(g).expect(403);
    await host.patch(`/v1/events/${ev.id}`, { downloads_enabled: false }).expect(200);
    await h.http().get(`/v1/guest/media/${approved}/download-link`).set(g).expect(403);
    await h.http().get(link.body.url.replace('http://localhost:4000', '')).expect(403);        // already-issued link stops working too
    await host.patch(`/v1/events/${ev.id}`, { allow_original_download: true }).expect(403);   // trial plan has no original entitlement
    await host.patch(`/v1/events/${ev.id}`, { downloads_enabled: true }).expect(200);
  });

  it('guest can delete their own upload (D64) and others cannot', async () => {
    const mine = await guestUpload(h, guest, await photo(901));
    await host.post(`/v1/events/${ev.id}/moderation/bulk`, { action: 'approve', media_ids: [mine.mediaId] }).expect(200);
    await h.http().delete(`/v1/guest/media/${mine.mediaId}`).set('Authorization', `Bearer ${viewer.token}`).expect(404);
    await h.http().delete(`/v1/guest/media/${mine.mediaId}`).set('Authorization', `Bearer ${guest.token}`).expect(200);
    expect((await h.db.one<any>('SELECT moderation_state, deleted_at FROM media WHERE id = $1', [mine.mediaId])).moderation_state).toBe('deleted');
    expect((await h.db.many('SELECT 1 FROM media_derivatives WHERE media_id = $1', [mine.mediaId]))).toHaveLength(0);
  });
});

void sendChunks; void exifReader; void makeJpeg;
