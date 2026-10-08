import { Client_, Harness, bootHarness, createEvent, guestUpload, joinAsGuest, photo } from '../helpers/harness';

let h: Harness;
beforeAll(async () => { h = await bootHarness(); });
afterAll(async () => { await h.close(); });

/** Pinterest-style gallery: boards of senders (by display name) and albums, filters, and the host's privacy switch. */
/** Upgrade an upload-only guest session with gallery scope (same session, so "mine" and sender names carry over). */
const withGallery = async (ev: { galleryToken: string; joinCode: string }, g: { token: string }) => (await joinAsGuest(h, ev.galleryToken, { code: ev.joinCode }, g.token).then((r) => { if (r.status !== 200) throw new Error(`gallery join ${r.status} ${JSON.stringify(r.body)}`); return r; })).body;

describe('gallery by sender / mine / albums', () => {
  it('groups photos per sender name, filters by sender and "mine", exposes only opaque keys and names', async () => {
    const host = await Client_.host(h);
    const ev = await createEvent(h, host, {}, 'trial');
    await host.patch(`/v1/events/${ev.id}`, { moderation_mode: 'post', join_code_scope: 'both' }).expect(200);
    const abebe = (await joinAsGuest(h, ev.uploadToken, { code: ev.joinCode, display_name: 'Abebe K.' })).body;
    const sara = (await joinAsGuest(h, ev.uploadToken, { code: ev.joinCode, display_name: 'ሳራ' })).body;
    const anon = (await joinAsGuest(h, ev.uploadToken, { code: ev.joinCode })).body;
    await guestUpload(h, abebe, await photo(11)); await guestUpload(h, abebe, await photo(12));
    await guestUpload(h, sara, await photo(13));
    await guestUpload(h, anon, await photo(14));
    const abebeG = await withGallery(ev, abebe); const saraG = await withGallery(ev, sara);

    const auth = (g: { token: string }) => ({ Authorization: `Bearer ${g.token}` });
    void anon;
    const senders = (await h.http().get('/v1/guest/senders').set(auth(abebeG)).expect(200)).body;
    expect(senders.enabled).toBe(true);
    expect(senders.senders.map((s: any) => [s.name, s.count]).sort()).toEqual([['Abebe K.', 2], ['ሳራ', 1]].sort());
    expect(senders.unnamed).toBe(1);
    expect(senders.senders.find((s: any) => s.name === 'Abebe K.').mine).toBe(true);
    for (const s of senders.senders) {
      expect(s.key).toMatch(/^[0-9a-f]{12}$/);
      expect(s.covers.length).toBeGreaterThan(0);
      expect(JSON.stringify(s)).not.toMatch(/session|phone|user_id/i);   // opaque keys only
    }

    const all = (await h.http().get('/v1/guest/media').set(auth(saraG)).expect(200)).body.items;
    expect(all).toHaveLength(4);
    expect(all.filter((i: any) => i.sender?.name === 'Abebe K.')).toHaveLength(2);

    const abeKey = senders.senders.find((s: any) => s.name === 'Abebe K.').key;
    const byAbe = (await h.http().get(`/v1/guest/media?sender=${abeKey}`).set(auth(saraG)).expect(200)).body.items;
    expect(byAbe).toHaveLength(2);
    expect(byAbe.every((i: any) => i.sender.name === 'Abebe K.' && i.mine === false)).toBe(true);
    expect((await h.http().get('/v1/guest/media?mine=true').set(auth(saraG)).expect(200)).body.items).toHaveLength(1);
    await h.http().get('/v1/guest/media?sender=not-a-key').set(auth(saraG)).expect(400);

    // host switch: names off -> no names or keys leak, sender filter ignored
    await host.patch(`/v1/events/${ev.id}`, { show_uploader_names: false }).expect(200);
    const off = (await h.http().get('/v1/guest/senders').set(auth(saraG)).expect(200)).body;
    expect(off).toEqual({ enabled: false, senders: [], unnamed: 0 });
    const offItems = (await h.http().get('/v1/guest/media').set(auth(saraG)).expect(200)).body.items;
    expect(offItems.every((i: any) => i.sender === null)).toBe(true);
    expect((await h.http().get(`/v1/guest/media?sender=${abeKey}`).set(auth(saraG)).expect(200)).body.items).toHaveLength(4);
    await host.patch(`/v1/events/${ev.id}`, { show_uploader_names: true }).expect(200);

    // host/moderator view
    const hs = (await host.get(`/v1/events/${ev.id}/media-senders`).expect(200)).body.senders;
    expect(hs.reduce((n: number, s: any) => n + s.count, 0)).toBe(4);
    const hostByAbe = (await host.get(`/v1/events/${ev.id}/media?filter=all&sender=${abeKey}`).expect(200)).body.items;
    expect(hostByAbe).toHaveLength(2);
  });

  it('albums carry counts and cover thumbnails; other events never leak across senders', async () => {
    const host = await Client_.host(h);
    const ev = await createEvent(h, host, {}, 'trial');
    await host.patch(`/v1/events/${ev.id}`, { moderation_mode: 'post', join_code_scope: 'both' }).expect(200);
    const g = (await joinAsGuest(h, ev.uploadToken, { code: ev.joinCode, display_name: 'Meron' })).body;
    const up = await guestUpload(h, g, await photo(21));
    const gG = await withGallery(ev, g);
    const folder = (await host.post(`/v1/events/${ev.id}/folders`, { name: 'Ceremony' }).expect(200)).body.folders.find((x: any) => x.name === 'Ceremony');
    await host.patch(`/v1/media/${up.mediaId}`, { folder_id: folder.id }).expect(200);
    await host.patch(`/v1/folders/${folder.id}`, { publication_state: 'published' }).expect(200);
    const f = (await h.http().get('/v1/guest/folders').set({ Authorization: `Bearer ${gG.token}` }).expect(200)).body.folders;
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ name: 'Ceremony', count: 1 });
    expect(f[0].covers).toHaveLength(1);

    const host2 = await Client_.host(h);                                // trial is once per host
    const other = await createEvent(h, host2, { join_code_scope: 'both' }, 'trial');
    const g2 = (await joinAsGuest(h, other.galleryToken, { code: other.joinCode, display_name: 'Meron' })).body;
    const s2 = (await h.http().get('/v1/guest/senders').set({ Authorization: `Bearer ${g2.token}` }).expect(200)).body;
    expect(s2.senders).toEqual([]);                                   // same name, different event: nothing shared
  });
});
