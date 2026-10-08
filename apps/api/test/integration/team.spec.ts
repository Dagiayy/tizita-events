import { Client_, Harness, bootHarness, createEvent, joinAsGuest, nextPhone, photo, sendChunks } from '../helpers/harness';
import { ProcessingService } from '../../src/media/processing.service';
import { SignedUrlService } from '../../src/media/signed-url.service';
import { normalizeEthiopianPhone } from '../../src/common/phone';
import { MemorySmsProvider } from '../../src/notifications/notifications.service';

let h: Harness;
beforeAll(async () => { h = await bootHarness(); });
afterAll(async () => { await h.close(); });

async function memberUpload(c: Client_, eventId: string, buf: Buffer, folder?: string) {
  const intent = await c.post(`/v1/events/${eventId}/uploads/intents`, { mime: 'image/jpeg', size: buf.length, ...(folder ? { folder_id: folder } : {}) });
  if (intent.status !== 200) return { intent, id: null as string | null };
  await sendChunks(h, intent.body.upload, buf);
  await h.http().post(`/v1/media/${intent.body.media_id}/complete`).set('X-Upload-Token', intent.body.upload.token).expect(200);
  await h.get<ProcessingService>(ProcessingService).process(intent.body.media_id);
  return { intent, id: intent.body.media_id as string };
}

describe('Roles: owner, moderator, photographer (spec section 4)', () => {
  it('invitations by phone: existing users join immediately, new numbers activate on first sign-in; plan seat limits apply', async () => {
    const owner = await Client_.host(h); const ev = await createEvent(h, owner);
    const modUser = await Client_.host(h);
    const newPhone = nextPhone();
    await owner.post(`/v1/events/${ev.id}/members`, { phone: modUser.phone, role: 'moderator' }).expect(200);
    await owner.post(`/v1/events/${ev.id}/members`, { phone: modUser.phone, role: 'moderator' }).expect(409);
    await owner.post(`/v1/events/${ev.id}/members`, { phone: newPhone, role: 'photographer' }).expect(403);            // trial plan has no photographer seat
    await owner.post(`/v1/events/${ev.id}/members`, { phone: newPhone, role: 'moderator' }).expect(403);               // collaborator limit reached
    expect((await modUser.get(`/v1/events/${ev.id}`).expect(200)).body.role).toBe('moderator');

    const ev2 = await createEvent(h, owner, {}, 'none');
    const o = (await owner.post('/v1/payments/orders', { event_id: ev2.id, plan_code: 'event_plus' })).body;
    await h.http().post('/v1/dev/sandbox/pay').send({ tx_ref: o.order_ref, outcome: 'success' }).expect(200);
    const members = (await owner.post(`/v1/events/${ev2.id}/members`, { phone: newPhone, role: 'photographer' }).expect(200)).body.members;
    expect(members.find((m: any) => m.status === 'invited')).toBeTruthy();
    expect(MemorySmsProvider.last(normalizeEthiopianPhone(newPhone)!)).toMatch(/invited/);
    const photographer = await Client_.host(h, newPhone);
    expect((await photographer.get(`/v1/events/${ev2.id}`).expect(200)).body.role).toBe('photographer');
    const list = (await owner.get(`/v1/events/${ev2.id}/members`)).body.members;
    expect(list.map((m: any) => m.status)).toEqual(['active', 'active']);
    await owner.del(`/v1/events/${ev2.id}/members/${list.find((m: any) => m.role === 'photographer').id}`).expect(200);
    await photographer.get(`/v1/events/${ev2.id}`).expect(404);                                                         // removal is immediate
  });

  it('moderator can moderate/block/view insights but not billing, settings, secrets, deletion or ownership', async () => {
    const owner = await Client_.host(h); const ev = await createEvent(h, owner);
    const mod = await Client_.host(h);
    await owner.post(`/v1/events/${ev.id}/members`, { phone: mod.phone, role: 'moderator' }).expect(200);
    await memberUpload(owner, ev.id, await photo(1));
    await mod.get(`/v1/events/${ev.id}/moderation`).expect(200);
    await mod.get(`/v1/events/${ev.id}/insights`).expect(200);
    await mod.get(`/v1/events/${ev.id}/share-links`).expect(200);
    await mod.patch(`/v1/events/${ev.id}`, { name: 'x' }).expect(403);
    await mod.post(`/v1/events/${ev.id}/close`, { mode: 'now' }).expect(403);
    await mod.post(`/v1/events/${ev.id}/delete`, { confirm_name: 'x' }).expect(403);
    await mod.post(`/v1/events/${ev.id}/members`, { phone: nextPhone(), role: 'moderator' }).expect(403);
    await mod.post(`/v1/events/${ev.id}/secrets/rotate`, { type: 'upload_token' }).expect(403);
    await mod.post('/v1/payments/orders', { event_id: ev.id, plan_code: 'event_plus' }).expect(403);
    await mod.post(`/v1/events/${ev.id}/exports`, { scope: 'full' }).expect(403);
    await mod.get(`/v1/events/${ev.id}/payments`).expect(403);
  });

  it('photographer workflow: folder uploads auto-approve, folder hidden until published, highlights, own-media scope, no security changes', async () => {
    const owner = await Client_.host(h);
    const ev = await createEvent(h, owner, { gallery_access_mode: 'view_only' }, 'none');
    const o = (await owner.post('/v1/payments/orders', { event_id: ev.id, plan_code: 'professional' })).body;
    await h.http().post('/v1/dev/sandbox/pay').send({ tx_ref: o.order_ref, outcome: 'success' }).expect(200);
    const links = (await owner.get(`/v1/events/${ev.id}/share-links`)).body;
    const pg = await Client_.host(h);
    await owner.post(`/v1/events/${ev.id}/members`, { phone: pg.phone, role: 'photographer' }).expect(200);
    const myFolder = (await pg.post(`/v1/events/${ev.id}/folders`, { name: 'የሠርግ ሥነ ሥርዓት - Ceremony set', publication_state: 'draft' }).expect(200)).body.folders.find((f: any) => f.name.startsWith('የሠርግ'));
    expect(myFolder.publication_state).toBe('draft');
    const receptionId = (await owner.get(`/v1/events/${ev.id}/folders`)).body.folders.find((f: any) => f.name === 'Reception').id;

    const p1 = await memberUpload(pg, ev.id, await photo(11), myFolder.id);
    const p2 = await memberUpload(pg, ev.id, await photo(12), myFolder.id);
    const ownerShot = await memberUpload(owner, ev.id, await photo(13), receptionId);
    expect((await h.db.one<any>('SELECT moderation_state FROM media WHERE id = $1', [p1.id])).moderation_state).toBe('approved');
    const viewer = (await joinAsGuest(h, links.gallery_url.split('/j/')[1])).body;
    const visible = async () => (await h.http().get('/v1/guest/media').set('Authorization', `Bearer ${viewer.token}`)).body.items.map((i: any) => i.id);
    expect(await visible()).toEqual([ownerShot.id]);                                                                       // draft folder hidden from guests
    await h.http().get(h.get<SignedUrlService>(SignedUrlService).mediaUrl(p1.id!, 'viewer', 'pub').replace('http://localhost:4000', '')).expect(404);
    const mine = (await pg.get(`/v1/events/${ev.id}/media`).expect(200)).body.items.map((i: any) => i.id);
    expect(mine.sort()).toEqual([p1.id, p2.id].sort());
    await pg.patch(`/v1/media/${ownerShot.id}`, { is_highlight: true }).expect(403);
    await pg.patch(`/v1/media/${p1.id}`, { is_highlight: true }).expect(200);
    await pg.post(`/v1/media/${p1.id}/hide`).expect(403);
    await pg.get(`/v1/events/${ev.id}/moderation`).expect(403);
    await pg.patch(`/v1/events/${ev.id}`, { gallery_access_mode: 'open' }).expect(403);
    await pg.post(`/v1/events/${ev.id}/secrets/rotate`, { type: 'passcode', passcode: 'abcd' }).expect(403);
    await pg.get(`/v1/events/${ev.id}/share-links`).expect(403);
    await pg.post(`/v1/events/${ev.id}/exports`, { scope: 'full' }).expect(403);
    await pg.post('/v1/payments/orders', { event_id: ev.id, plan_code: 'event_plus' }).expect(403);
    await pg.patch(`/v1/folders/${myFolder.id}`, { publication_state: 'published', cover_media_id: p1.id }).expect(200);
    await pg.patch(`/v1/folders/${receptionId}`, { name: 'hijack' }).expect(403);                                          // not their folder
    expect((await visible()).sort()).toEqual([ownerShot.id, p1.id, p2.id].sort());
    const gf = (await h.http().get('/v1/guest/folders').set('Authorization', `Bearer ${viewer.token}`)).body.folders.map((f: any) => f.name);
    expect(gf).toEqual(expect.arrayContaining(['የሠርግ ሥነ ሥርዓት - Ceremony set']));
    const hi = (await h.http().get('/v1/guest/media?highlights=true').set('Authorization', `Bearer ${viewer.token}`)).body.items.map((i: any) => i.id);
    expect(hi).toEqual([p1.id]);
    const g = (await joinAsGuest(h, links.upload_url.split('/j/')[1], { code: links.join_code })).body;
    expect((await h.http().post('/v1/guest/uploads/intents').set('Authorization', `Bearer ${g.token}`).send({ mime: 'image/jpeg', size: 100, folder_id: myFolder.id })).status).toBe(403);
    await pg.patch(`/v1/folders/${myFolder.id}`, { download_allowed: false }).expect(200);
    await h.http().get(`/v1/guest/media/${p1.id}/download-link`).set('Authorization', `Bearer ${viewer.token}`).expect(403);
    await h.http().get(`/v1/guest/media/${ownerShot.id}/download-link`).set('Authorization', `Bearer ${viewer.token}`).expect(200);
  });
});
