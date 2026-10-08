import { expect, test } from '@playwright/test';
import { FIXED_OTP, apiCall, jpeg, makeEvent, randomPhone, rel } from './helpers';

/** Host console in a desktop browser: OTP sign-in, create event, pay (sandbox), QR/share, moderate, export, close. */
test.describe('Event owner console', () => {
  test('sign in with +251 OTP, create an event with an Ethiopian-calendar date, pay in ETB, share QR, moderate, export, close', async ({ page }) => {
    const phone = randomPhone();
    await page.goto('/host');
    await page.getByLabel(/Mobile number/).fill(phone);
    await page.getByRole('button', { name: 'Send code' }).click();
    await page.getByLabel(/Verification code/).fill(FIXED_OTP);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('heading', { name: 'My events' })).toBeVisible();
    await expect(page.getByText(/no events yet/)).toBeVisible();

    // create: Ethiopian calendar entry for the start date
    await page.getByRole('link', { name: /New event/ }).click();
    await page.getByLabel('Event name').fill('የአበበ ልደት Birthday');
    await page.getByLabel('Event type').selectOption('birthday');
    await page.getByRole('radio', { name: 'Ethiopian' }).first().check();
    await expect(page.getByLabel('month', { exact: true }).first()).toBeVisible();
    await page.getByLabel('year', { exact: true }).first().fill('2019');
    await page.getByLabel('month', { exact: true }).first().selectOption({ index: 0 });
    await page.getByLabel('day', { exact: true }).first().selectOption('11');                                              // 11 Meskerem 2019 == 21 Sep 2026
    await page.getByLabel('City').fill('Bahir Dar');
    await page.getByRole('button', { name: 'Create event' }).click();
    await expect(page).toHaveURL(/\/host\/events\/[0-9a-f-]{36}/);
    await expect(page.getByRole('heading', { name: 'የአበበ ልደት Birthday' })).toBeVisible();
    await expect(page.getByText('Draft').first()).toBeVisible();
    await expect(page.getByText(/21 September 2026/).first()).toBeVisible();                                      // converted to Gregorian (EAT)
    await expect(page.getByText(/11 Meskerem 2019/).first()).toBeVisible();

    // package in ETB; sandbox gateway; entitlement only after verification
    const eventUrl = page.url();
    await page.getByRole('tab', { name: 'Package' }).click();
    await expect(page.getByText('1,200 ETB')).toBeVisible();
    await expect(page.getByText('Pay with telebirr / bank / M-Pesa').first()).toBeVisible();
    await page.getByRole('button', { name: /Pay with telebirr/ }).first().click();
    await expect(page).toHaveURL(/pay\/sandbox\?ref=ord_/);
    await expect(page.getByText(/SANDBOX PAYMENT GATEWAY/)).toBeVisible();
    await page.getByRole('button', { name: 'Pay (success)' }).click();
    await expect(page.getByText('Result: activated')).toBeVisible();
    await page.goto(eventUrl);
    await expect(page.getByText(/Scheduled|Live/).first()).toBeVisible();

    // share: separate upload/gallery QR (real images) + links + join code
    await page.getByRole('tab', { name: 'Share' }).click();
    await expect(page.getByText(/different secrets/)).toBeVisible();
    const qrs = page.locator('.qr img');
    await expect(qrs).toHaveCount(2, { timeout: 20_000 });
    for (const i of [0, 1]) await expect(async () => expect(await qrs.nth(i).evaluate((e: HTMLImageElement) => e.complete && e.naturalWidth > 100)).toBe(true)).toPass();
    const links = await page.locator('code').allTextContents();
    expect(links.some((l) => /\/j\/u_/.test(l))).toBe(true); expect(links.some((l) => /\/j\/g_/.test(l))).toBe(true);
    const pdf = page.waitForEvent('download'); await page.getByRole('button', { name: /Printable card/ }).first().click();
    expect((await pdf).suggestedFilename()).toMatch(/upload-qr\.pdf/);
  });

  test('date fields can be typed digit by digit and edited (Ethiopian year, Gregorian date-time)', async ({ page, isMobile }) => {
    test.skip(isMobile, 'keyboard segment entry of datetime-local is desktop-only; phones use the native picker');
    await page.goto('/host');
    await page.getByLabel(/Mobile number/).fill(randomPhone());
    await page.getByRole('button', { name: 'Send code' }).click();
    await page.getByLabel(/Verification code/).fill(FIXED_OTP);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.getByRole('link', { name: /New event/ }).click();
    // Ethiopian: clear and type the year one key at a time, then change it again
    await page.getByRole('radio', { name: 'Ethiopian' }).first().check();
    const year = page.getByLabel('year', { exact: true }).first();
    await year.click(); await year.press('Control+A'); await year.pressSequentially('2020', { delay: 60 });
    await expect(year).toHaveValue('2020');
    await year.press('Backspace'); await year.press('Backspace'); await year.pressSequentially('19', { delay: 60 });
    await expect(year).toHaveValue('2019');
    await page.getByLabel('time', { exact: true }).first().fill('09:30');
    await expect(year).toHaveValue('2019');
    // Gregorian: type a full date-time with the keyboard
    await page.getByRole('radio', { name: 'Gregorian' }).first().check();
    const dt = page.locator('input[type=datetime-local]').first();
    await dt.click(); await dt.press('ArrowLeft'); await dt.press('ArrowLeft'); await dt.press('ArrowLeft'); await dt.press('ArrowLeft'); await dt.press('ArrowLeft');
    await dt.pressSequentially('03152031', { delay: 60 }); // month day year
    await expect(dt).toHaveValue(/^2031-03-15T/);
  });

  test('the event date can be edited after creation (Event details card)', async ({ page }) => {
    await page.goto('/host');
    await page.getByLabel(/Mobile number/).fill(randomPhone());
    await page.getByRole('button', { name: 'Send code' }).click();
    await page.getByLabel(/Verification code/).fill(FIXED_OTP);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.getByRole('link', { name: /New event/ }).click();
    await page.getByLabel('Event name').fill('Date edit test');
    await page.getByRole('button', { name: 'Create event' }).click();
    await expect(page).toHaveURL(/\/host\/events\/[0-9a-f-]{36}/);
    const card = page.locator('form', { hasText: 'Event details' });
    await expect(card).toBeVisible();
    const dts = card.locator('input[type=datetime-local]');
    await dts.nth(0).fill('2031-03-15T10:00'); await dts.nth(1).fill('2031-03-15T20:00');
    await dts.nth(2).fill('2031-03-14T09:00'); await dts.nth(3).fill('2031-03-16T09:00');
    await card.getByLabel('Event name').fill('Date edit test v2');
    await card.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByRole('heading', { name: 'Date edit test v2' })).toBeVisible();
    await expect(page.getByText(/15 March 2031/).first()).toBeVisible();
    await page.reload();
    await expect(page.getByText(/15 March 2031/).first()).toBeVisible();
  });

  test('moderate in the gallery tab: bulk approve, reject, highlight, export ZIP, close event', async ({ page }) => {
    // set up via API: live event with 3 guest uploads
    const phone = randomPhone();
    await apiCall('POST', '/auth/request-otp', null, { phone });
    const login = await apiCall<any>('POST', '/auth/verify-otp', null, { phone, code: FIXED_OTP });
    const token = login.body.access_token as string;
    const ev = await makeEvent(token);
    const g = (await apiCall<any>('POST', `/events/${new URL(ev.uploadUrl).pathname.split('/j/')[1]}/join`, null, { code: ev.code, consent: { notice_version: '2026-10-draft', accepted: true } })).body;
    for (let i = 0; i < 3; i++) {
      const buf = await jpeg(30 + i, 1200, 800);
      const it = (await apiCall<any>('POST', '/guest/uploads/intents', g.token, { mime: 'image/jpeg', size: buf.length })).body;
      for (let c = 0; c < it.upload.total_chunks; c++) await fetch(`${it.upload.url}/chunks/${c}`, { method: 'PUT', headers: { 'x-upload-token': it.upload.token }, body: buf.subarray(c * it.upload.chunk_bytes, (c + 1) * it.upload.chunk_bytes) as any });
      await apiCall('POST', `/media/${it.media_id}/complete`, null, undefined, { 'x-upload-token': it.upload.token });
    }
    await expect.poll(async () => (await apiCall<any>('GET', `/events/${ev.id}/moderation`, token)).body.counts.pending, { timeout: 60_000 }).toBe(3);

    // sign in through the UI and open the event
    await page.goto('/host');
    await page.getByLabel(/Mobile number/).fill(phone); await page.getByRole('button', { name: 'Send code' }).click();
    await page.getByLabel(/Verification code/).fill(FIXED_OTP); await page.getByRole('button', { name: 'Sign in' }).click();
    await page.getByRole('link', { name: /Abebe & Sara/ }).click();
    await page.getByRole('tab', { name: 'Gallery' }).click();
    const tiles = page.locator('.masonry .tile');
    await expect(tiles).toHaveCount(3);
    // select two, approve in bulk; reject the third
    await tiles.nth(0).locator('button.sel').click(); await tiles.nth(1).locator('button.sel').click();
    await expect(page.getByText('2 selected')).toBeVisible();
    await page.getByRole('button', { name: 'Approve', exact: true }).click();
    await expect(tiles).toHaveCount(1);                                                                       // only the pending one remains in the "Pending" filter
    await tiles.first().locator('button.sel').click(); await page.getByRole('button', { name: 'Reject', exact: true }).click();
    await expect(page.getByText('Nothing here yet.')).toBeVisible();
    await page.getByRole('button', { name: 'Approved', exact: true }).click();
    await expect(tiles).toHaveCount(2);
    await tiles.first().locator('img').click();
    await page.getByRole('button', { name: '★ Highlight', exact: true }).click();
    await expect.poll(async () => (await apiCall<any>('GET', `/events/${ev.id}/media?filter=highlights`, token)).body.items.length).toBe(1);

    // export: async job -> signed download
    await page.getByRole('tab', { name: 'Export' }).click();
    await page.getByRole('button', { name: 'Create export' }).click();
    await expect(page.getByRole('button', { name: /Download ZIP/ })).toBeVisible({ timeout: 60_000 });
    const dl = page.waitForEvent('download'); await page.getByRole('button', { name: /Download ZIP/ }).click();
    expect((await dl).suggestedFilename()).toMatch(/event-album-.*\.zip/);

    // insights, then close the event
    await page.getByRole('tab', { name: 'Insights' }).click();
    await expect(page.getByText('Guest journey')).toBeVisible();
    await page.getByRole('tab', { name: 'Overview' }).click();
    await page.getByRole('button', { name: 'Close uploads now' }).click();
    await expect(page.getByText(/Closing|Read-only/).first()).toBeVisible();
    expect((await apiCall<any>('GET', `/events/${ev.id}`, token)).body.allowed_actions).not.toContain('guest_upload');
  });

  test('language switch and account page (device sessions)', async ({ page }) => {
    const phone = randomPhone();
    await page.goto('/host');
    await page.getByRole('button', { name: 'አማ' }).click();
    await expect(page.getByRole('heading', { name: 'ይግቡ' })).toBeVisible();
    await page.getByLabel(/የሞባይል ቁጥር/).fill(phone); await page.getByRole('button', { name: 'ኮድ ላክ' }).click();
    await page.getByLabel(/የማረጋገጫ ኮድ/).fill(FIXED_OTP); await page.getByRole('button', { name: 'ይግቡ' }).last().click();
    await expect(page.getByRole('heading', { name: 'የእኔ ዝግጅቶች' })).toBeVisible();
    await page.goto('/host/account');
    await expect(page.getByRole('heading', { name: 'መሣሪያዎች እና ክፍለ ጊዜዎች' })).toBeVisible();
    await expect(page.getByText('ይህ መሣሪያ')).toBeVisible();
    void rel;
  });
});
