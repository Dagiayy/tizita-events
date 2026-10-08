import { expect, test } from '@playwright/test';
import { apiCall, approveAll, hostLogin, jpeg, makeEvent, rel } from './helpers';

/** Android Chrome profile (Pixel 5): QR -> web, no app install, camera/gallery upload, progress, gallery, Amharic, weak network. */
test.describe('Guest web/PWA on an Android phone', () => {
  test('QR link -> notice -> join -> choose photos -> upload with progress -> host approves -> live gallery -> viewer -> report', async ({ page, browser }) => {
    const host = await hostLogin(); const ev = await makeEvent(host.token, { captions_enabled: true, gallery_access_mode: 'view_only' });
    const code = ev.code;

    await page.goto(`${rel(ev.uploadUrl)}?c=${code}`);
    await expect(page.getByRole('heading', { name: /Abebe & Sara/ }).first()).toBeVisible();
    await expect(page.getByText(/Photos you upload are shared with the event host/)).toBeVisible();      // notice before upload
    const join = page.getByRole('button', { name: 'Join event' });
    await expect(join).toBeDisabled();                                                                     // consent is an active action
    await page.getByRole('checkbox').check();
    await page.getByLabel(/Your name/).fill('ሳራ');
    await join.click();

    // home: Take photo / Choose from gallery, data saver
    await expect(page.getByRole('button', { name: /Take photo/ })).toBeVisible();
    await expect(page.getByText('Data saver')).toBeVisible();
    const file = await jpeg(5, 2400, 1600);
    await page.locator('input[type=file]:not([capture])').setInputFiles([{ name: 'IMG_0001.jpg', mimeType: 'image/jpeg', buffer: file }, { name: 'IMG_0002.jpg', mimeType: 'image/jpeg', buffer: await jpeg(6, 2400, 1600) }]);
    await expect(page.getByText('2 photo(s) selected')).toBeVisible();
    await expect(page.getByText(/About .* to upload/)).toBeVisible();
    await page.getByLabel(/Caption/).fill('ከሠርጉ');
    await page.getByRole('button', { name: 'Upload 2' }).click();

    // per-item progress -> sent, waiting for approval (never shown as public)
    await expect(page.getByText('Sent. Waiting for the host to approve.').first()).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText('Sent. Waiting for the host to approve.')).toHaveCount(2, { timeout: 30_000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);   // no horizontal scroll on a phone
    // upload-only session cannot browse the gallery
    await expect(page.getByText(/To browse the gallery, scan the gallery QR/)).toBeVisible();

    // a gallery viewer on another device sees nothing until approval, then gets live updates
    const ctx2 = await browser.newContext({ viewport: { width: 360, height: 740 } }); const viewer = await ctx2.newPage();
    await viewer.goto(rel(ev.galleryUrl));
    await viewer.getByRole('button', { name: 'Join event' }).click();
    await viewer.getByRole('button', { name: /View gallery/ }).click();
    await expect(viewer.getByText(/No photos yet/)).toBeVisible();
    const approved = await approveAll(host.token, ev.id);
    expect(approved).toBe(2);
    const tiles = viewer.locator('.masonry img');
    await expect(tiles).toHaveCount(2, { timeout: 20_000 });                                              // live (SSE) or refetch
    await expect(async () => { const ok = await tiles.first().evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth > 0); expect(ok).toBe(true); }).toPass();
    expect(await tiles.first().getAttribute('loading')).toBe('lazy');

    // full-screen viewer, save/download link, share, report
    await tiles.first().click();
    await expect(viewer.getByRole('dialog')).toBeVisible();
    await expect(viewer.getByRole('button', { name: /Save photo/ })).toBeVisible();
    await viewer.getByRole('button', { name: /Report/ }).click();
    await viewer.getByLabel('Privacy concern / remove me').check();
    await viewer.getByRole('button', { name: 'Send report' }).click();
    await expect(viewer.getByText(/Thank you. The host will review this photo/)).toBeVisible();
    await ctx2.close();

    // the report flagged the photo: the host sees it in the moderation queue
    const q = await apiCall<any>('GET', `/events/${ev.id}/moderation`, host.token);
    expect(q.body.counts.flagged).toBe(1);
  });

  test('Amharic UI: Ethiopic text renders with the self-hosted font, no overflow, Ethiopian date shown', async ({ page }) => {
    const host = await hostLogin(); const ev = await makeEvent(host.token, { name: 'የአበበና ሳራ ሠርግ', language: 'am' });
    await page.goto(`${rel(ev.uploadUrl)}?c=${ev.code}`);
    await expect(page.getByRole('heading', { name: 'የአበበና ሳራ ሠርግ' }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'ዝግጅቱን ይቀላቀሉ' })).toBeVisible();                      // default language follows the event
    await expect(page.getByText(/ፎቶዎች የሰዎችን ፊት|የሚያስገቡት ፎቶዎች/)).toBeVisible();
    await expect(page.getByText(/መስከረም|ጥቅምት|ኅዳር|ታኅሣሥ|ጥር|የካቲት|መጋቢት|ሚያዝያ|ግንቦት|ሰኔ|ሐምሌ|ነሐሴ|ጳጉሜን/).first()).toBeVisible();   // Ethiopian calendar
    const fontLoaded = await page.evaluate(async () => { await document.fonts.ready; return [...document.fonts].some((f) => f.family.includes('Noto Sans Ethiopic') && f.status === 'loaded'); });
    expect(fontLoaded).toBe(true);
    expect(await page.evaluate(() => document.documentElement.lang)).toBe('am');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    // no request leaves the platform: fonts/scripts/images are first-party
    const external: string[] = []; page.on('request', (r) => { const u = new URL(r.url()); if (!['localhost', '127.0.0.1'].includes(u.hostname) && u.protocol.startsWith('http')) external.push(r.url()); });
    await page.getByRole('button', { name: 'EN' }).click();
    await expect(page.getByRole('button', { name: 'Join event' })).toBeVisible();
    expect(external).toEqual([]);
  });

  test('weak network: throttled 3G upload completes with visible progress; offline shows "waiting", then resumes', async ({ page, context }) => {
    const host = await hostLogin(); const ev = await makeEvent(host.token);
    await page.goto(`${rel(ev.uploadUrl)}?c=${ev.code}`);
    await page.getByRole('checkbox').check(); await page.getByRole('button', { name: 'Join event' }).click();
    await expect(page.getByRole('button', { name: /Choose from gallery/ })).toBeVisible();
    const cdp = await context.newCDPSession(page);
    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 300, downloadThroughput: (400 * 1024) / 8, uploadThroughput: (400 * 1024) / 8 });   // ~Slow 3G
    await page.locator('input[type=file]:not([capture])').setInputFiles({ name: 'a.jpg', mimeType: 'image/jpeg', buffer: await jpeg(9, 3000, 2000) });
    await page.getByLabel(/Data saver/).check();                                                                     // data saver on: smaller upload
    await page.getByRole('button', { name: /^Upload 1/ }).click();
    await expect(page.getByText(/Uploading \d+%/).first()).toBeVisible({ timeout: 30_000 });
    await context.setOffline(true);
    await expect(page.getByText(/Waiting for connection|Connection problem/).first()).toBeVisible({ timeout: 30_000 });
    await context.setOffline(false);
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    await expect(page.getByText('Sent. Waiting for the host to approve.')).toBeVisible({ timeout: 90_000 });
    const m = await apiCall<any>('GET', `/events/${ev.id}/moderation`, host.token);
    expect(m.body.counts.pending).toBe(1);                                                                          // exactly once, despite the interruption
  });

  test('manual join with the short code; wrong code is refused', async ({ page }) => {
    const host = await hostLogin(); const ev = await makeEvent(host.token);
    await page.goto('/join');
    await page.getByLabel(/Join code/).fill(ev.code); await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page).toHaveURL(new RegExp(`/j/${ev.code}`));
    await page.getByRole('checkbox').check(); await page.getByRole('button', { name: 'Join event' }).click();
    await expect(page.getByRole('button', { name: /Take photo/ })).toBeVisible();
    await page.goto('/j/ZZZZZZZZ');
    await expect(page.getByText(/could not find this event/)).toBeVisible();
  });

  test('privacy page: guests can file a removal request without an account and check status', async ({ page }) => {
    const host = await hostLogin(); const ev = await makeEvent(host.token);
    await page.goto('/privacy');
    await page.getByLabel('Event link or code').fill(ev.code); await page.getByLabel('Details').fill('please remove the photo of me');
    await page.getByRole('button', { name: 'Submit request' }).click();
    await expect(page.getByText('Request received')).toBeVisible();
    const ref = (await page.locator('strong').filter({ hasText: /^RR-/ }).textContent())!;
    const token = (await page.locator('code').first().textContent())!;
    await page.getByLabel('Reference').last().fill(ref); await page.getByLabel(/private key/).last().fill(token);
    await page.getByRole('button', { name: 'Check status' }).click();
    await expect(page.locator('.alert.ok').getByText(/received/)).toBeVisible();
  });
});
