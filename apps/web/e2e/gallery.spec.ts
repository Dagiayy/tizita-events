import { expect, test } from '@playwright/test';
import { apiCall, hostLogin, jpeg, makeEvent, rel } from './helpers';

/** Pinterest-style guest gallery on a phone: masonry wall, People boards (by sender name), Albums, Yours, names toggle. */
test.describe('Gallery wall (phone)', () => {
  test('browse all at once, by sender name, and by album; names can be switched off by the host', async ({ page }) => {
    const host = await hostLogin();
    const ev = await makeEvent(host.token, { moderation_mode: 'post', gallery_access_mode: 'view_only' });
    const loc = new URL(ev.uploadUrl).pathname.split('/j/')[1];
    const join = async (name: string) => (await apiCall<any>('POST', `/events/${loc}/join`, null, { code: ev.code, display_name: name, consent: { notice_version: '2026-10-draft', accepted: true } })).body;
    const send = async (g: any, seed: number) => {
      const buf = await jpeg(seed, 1200, 800 + (seed % 3) * 300);   // varied heights -> real masonry
      const it = (await apiCall<any>('POST', '/guest/uploads/intents', g.token, { mime: 'image/jpeg', size: buf.length })).body;
      for (let c = 0; c < it.upload.total_chunks; c++) await fetch(`${it.upload.url}/chunks/${c}`, { method: 'PUT', headers: { 'x-upload-token': it.upload.token }, body: buf.subarray(c * it.upload.chunk_bytes, (c + 1) * it.upload.chunk_bytes) as any });
      await apiCall('POST', `/media/${it.media_id}/complete`, null, undefined, { 'x-upload-token': it.upload.token });
      return it.media_id as string;
    };
    const abebe = await join('Abebe K.'); const sara = await join('Sara T.');
    const ids = [await send(abebe, 41), await send(abebe, 42), await send(sara, 43)];
    const gloc = new URL(ev.galleryUrl).pathname.split('/j/')[1];
    const viewerG = (await apiCall<any>('POST', `/events/${gloc}/join`, null, { display_name: 'Viewer V.', consent: { notice_version: '2026-10-draft', accepted: true } })).body;
    await expect.poll(async () => (await apiCall<any>('GET', '/guest/media', viewerG.token)).body.items.length, { timeout: 60_000 }).toBe(3);

    // an album with two photos
    const fr = await apiCall<any>('POST', `/events/${ev.id}/folders`, host.token, { name: 'Ceremony' });
    expect([200, 201], JSON.stringify(fr.body)).toContain(fr.status);
    const folder = fr.body.folders.find((f: any) => f.name === 'Ceremony');
    for (const id of ids.slice(0, 2)) { const r = await apiCall('PATCH', `/media/${id}`, host.token, { folder_id: folder.id }); expect(r.status, JSON.stringify(r.body)).toBe(200); }
    const pr = await apiCall('PATCH', `/folders/${folder.id}`, host.token, { publication_state: 'published' });
    expect(pr.status, JSON.stringify(pr.body)).toBe(200);

    await page.goto(rel(ev.galleryUrl));
    await page.getByRole('button', { name: 'Join event' }).click();
    await page.getByRole('button', { name: /View gallery/ }).click();

    // All at once: masonry wall with sender labels
    const tiles = page.locator('.masonry.pin .tile');
    await expect(tiles).toHaveCount(3, { timeout: 20_000 });
    await expect(page.locator('.tile .who').filter({ hasText: 'Abebe K.' })).toHaveCount(2);
    await expect(page.locator('.tile .who').filter({ hasText: 'Sara T.' })).toHaveCount(1);
    await page.getByLabel('Names').uncheck();
    await expect(page.locator('.tile .who')).toHaveCount(0);
    await page.getByLabel('Names').check();

    // People: boards by name -> open one
    await page.getByRole('tab', { name: 'People' }).click();
    const abeBoard = page.locator('.board', { hasText: 'Abebe K.' });
    await expect(abeBoard).toBeVisible(); await expect(abeBoard).toContainText('2 photos');
    await expect(page.locator('.board', { hasText: 'Sara T.' })).toContainText('1 photos');
    await abeBoard.click();
    await expect(page.getByRole('heading', { name: 'Abebe K.' })).toBeVisible();
    await expect(tiles).toHaveCount(2);
    // viewer offers "more from" the sender
    await tiles.first().click();
    await expect(page.getByRole('button', { name: /Abebe K\. · more from them/ })).toBeVisible();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: /← People/ }).click();
    await expect(page.locator('.boards')).toBeVisible();

    // Albums
    await page.getByRole('tab', { name: 'Albums' }).click();
    const album = page.locator('.board', { hasText: 'Ceremony' });
    await expect(album).toContainText('2 photos'); await album.click();
    await expect(tiles).toHaveCount(2);

    // images actually render (fade-in completed)
    await expect(async () => { const ok = await tiles.first().locator('img').evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth > 0 && i.classList.contains('ld')); expect(ok).toBe(true); }).toPass();

    // host privacy switch: names off -> People tab disappears, no labels
    await apiCall('PATCH', `/events/${ev.id}`, host.token, { show_uploader_names: false });
    await page.reload();
    await page.getByRole('button', { name: /View gallery/ }).click();
    await expect(page.getByRole('tab', { name: 'People' })).toHaveCount(0);
    await expect(tiles).toHaveCount(3);
    await expect(page.locator('.tile .who')).toHaveCount(0);
  });
});
