/* Screenshots every page of the web app into screenshots/web.   node tools/capture-web.cjs
 * Needs: API on :4000, web on :3100, OTP_FIXED_CODE=123456, ADMIN_MFA_REQUIRED=false, and the showcase event (tools/seed-showcase.cjs). */
const path = require('path');
const fs = require('fs');
const { chromium } = require(path.resolve(__dirname, '../apps/web/node_modules/@playwright/test'));

const BASE = 'http://localhost:3100';
const OUT = path.resolve(__dirname, '../screenshots/web');
const HOST = '0911000009', ADMIN = '+251911000001';
const SHOW = { code: process.env.SHOW_CODE || 'Q27DXGTU', upload: process.env.SHOW_UPLOAD || 'u_9DsJ6IYSyxA8YHM9FW1vOoruKJLOO6Cw', gallery: process.env.SHOW_GALLERY || 'g_o7FpLrs6VeRL5BhAmb6vA7FosPg0M7B0' };
fs.mkdirSync(OUT, { recursive: true });
let n = 0;

const DESKTOP = { width: 1440, height: 900 }, PHONE = { width: 390, height: 844 };
let browser;
const newPage = async (viewport, mobile = false) => {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: mobile ? 2 : 1, isMobile: mobile, hasTouch: mobile });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => console.log('  pageerror:', String(e).slice(0, 160)));
  return p;
};
const settle = async (p, ms = 900) => { await p.waitForLoadState('networkidle').catch(() => {}); await p.addStyleTag({ content: 'nextjs-portal, [data-nextjs-toast]{display:none!important}' }).catch(() => {}); await p.waitForTimeout(ms); };
const go = async (p, url, ms) => { await p.goto(BASE + url, { waitUntil: 'domcontentloaded' }); await settle(p, ms); };
const shot = async (p, name) => { n++; const f = `${String(n).padStart(2, '0')}-${name}.png`; await p.screenshot({ path: path.join(OUT, f) }); console.log('  ', f); };
const login = async (p, phone, url) => {
  await go(p, url);
  await p.locator('input[type=tel]').fill(phone);
  await p.getByRole('button', { name: /send code/i }).click(); await p.waitForTimeout(1200);
  await p.locator('input[autocomplete="one-time-code"]').fill('123456');
  await p.getByRole('button', { name: /verify|sign in/i }).click(); await settle(p, 1800);
};
const tryStep = async (label, fn) => { try { await fn(); } catch (e) { console.log(`  ! ${label}: ${String(e.message).split('\n')[0].slice(0, 120)}`); } };

(async () => {
  browser = await chromium.launch({ channel: 'msedge' });

  console.log('Public pages');
  let p = await newPage(DESKTOP);
  await go(p, '/'); await shot(p, 'landing');
  await tryStep('landing am', async () => { await p.getByRole('button', { name: 'አማ' }).click(); await p.waitForTimeout(500); await shot(p, 'landing-amharic'); });
  p = await newPage(DESKTOP); await go(p, '/join'); await shot(p, 'join-with-code');
  await go(p, '/privacy'); await shot(p, 'privacy-notice');

  console.log('Guest (phone)');
  p = await newPage(PHONE, true);
  await go(p, `/j/${SHOW.upload}`, 1500); await shot(p, 'guest-invitation');
  await tryStep('guest join', async () => {
    await go(p, `/j/${SHOW.code}`, 1500); // the short join code opens both upload and gallery
    const codeField = p.locator('label.field', { hasText: /join code/i }).locator('input');
    if (await codeField.count()) await codeField.fill(SHOW.code);
    await p.locator('label.field', { hasText: /your name/i }).locator('input').fill('Selam T.');
    await p.locator('label.check input').check();
    await shot(p, 'guest-join-form-filled');
    await p.locator('form button.btn.primary').click(); await settle(p, 2500);
    await shot(p, 'guest-home');
  });
  await tryStep('guest upload', async () => {
    const f = path.join(require('os').tmpdir(), 'showcase-upload.jpg');
    const sharp = require(path.resolve(__dirname, '../apps/api/node_modules/sharp'));
    await sharp(path.resolve(__dirname, '../apps/web/public/samples/graduation.jpg')).extract({ left: 200, top: 60, width: 760, height: 560 }).jpeg().toFile(f);
    const [fc] = await Promise.all([p.waitForEvent('filechooser'), p.locator('.action.dark').click()]);
    await fc.setFiles(f); await settle(p, 1500); await shot(p, 'guest-upload-preview');
    await p.locator('.actionbar .btn.primary, .btn.primary.big').last().click(); await settle(p, 5000); await shot(p, 'guest-upload-progress');
  });
  await tryStep('guest gallery', async () => {
    await p.locator('.gnav button', { hasText: /gallery/i }).click();
    await settle(p, 3000); await shot(p, 'guest-gallery-all');
    await p.locator('.gtabs .chip').nth(1).click(); await settle(p, 2000); await shot(p, 'guest-gallery-highlights');
    await p.locator('.gtabs .chip', { hasText: /people/i }).click(); await settle(p, 2500); await shot(p, 'guest-gallery-people');
    await p.locator('.board').first().click(); await settle(p, 2500); await shot(p, 'guest-gallery-one-person');
    await p.locator('.gtabs .chip', { hasText: /^all$/i }).click(); await settle(p, 2000);
    await p.locator('.tile').first().click(); await settle(p, 1500); await shot(p, 'guest-photo-viewer');
  });
  p = await newPage(DESKTOP);
  await tryStep('slideshow', async () => { await go(p, `/slideshow/${SHOW.gallery}`, 3000); await shot(p, 'live-slideshow'); });

  console.log('Host console');
  p = await newPage(DESKTOP);
  await go(p, '/host'); await shot(p, 'host-sign-in');
  await p.locator('input[type=tel]').fill(HOST);
  await p.getByRole('button', { name: /send code/i }).click(); await p.waitForTimeout(1200); await shot(p, 'host-sign-in-code');
  await p.locator('input[autocomplete="one-time-code"]').fill('123456');
  await p.getByRole('button', { name: /verify|sign in/i }).click(); await settle(p, 2000);
  await shot(p, 'host-my-events');
  await go(p, '/host/new'); await shot(p, 'host-create-event');
  await go(p, '/host', 1200); await p.getByText('Addis Tech Summit 2026').first().click(); await settle(p, 2500);
  for (const [tab, name] of [['Overview', 'overview'], ['Share', 'share-qr'], ['Gallery', 'gallery-moderation'], ['Folders', 'folders'], ['Team', 'team'], ['Export', 'exports'], ['Insights', 'insights'], ['Settings', 'settings-cover'], ['Package', 'package']]) {
    await tryStep(`host ${tab}`, async () => { await p.getByRole('tab', { name: tab, exact: true }).click(); await settle(p, 1800); await shot(p, `host-event-${name}`); if (tab === 'Gallery') { await p.getByRole('button', { name: 'Approved', exact: true }).click(); await settle(p, 2500); await shot(p, 'host-event-gallery-approved'); } });
  }
  await go(p, '/host/account'); await shot(p, 'host-account');

  console.log('Platform admin');
  p = await newPage(DESKTOP);
  await go(p, '/admin'); await shot(p, 'admin-sign-in');
  await p.locator('input[type=tel]').fill(ADMIN);
  await p.getByRole('button', { name: /send code/i }).click(); await p.waitForTimeout(1200);
  await p.locator('input[autocomplete="one-time-code"]').fill('123456');
  await p.getByRole('button', { name: /verify|sign in/i }).click(); await settle(p, 2500);
  for (const [url, name] of [['/admin', 'dashboard'], ['/admin/events', 'events'], ['/admin/orgs', 'users-and-organizations'], ['/admin/payments', 'payments'], ['/admin/storage', 'storage'], ['/admin/moderation', 'moderation'], ['/admin/access', 'media-access'], ['/admin/compliance', 'compliance'], ['/admin/audit', 'audit-log'], ['/admin/config', 'configuration']]) {
    await tryStep(url, async () => { await go(p, url, 1800); await shot(p, `admin-${name}`); });
  }

  await browser.close();
  console.log(`Done: ${n} screenshots in ${OUT}`);
})();
