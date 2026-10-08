/* Screenshots every screen of the Flutter app (running in Chrome/Edge at :5000) into screenshots/mobile.   node tools/capture-mobile.cjs
 * Needs: API on :4000, the Flutter web build served on :5000, the showcase event (tools/seed-showcase.cjs) and the demo events. */
const path = require('path');
const fs = require('fs');
const os = require('os');
const { chromium } = require(path.resolve(__dirname, '../apps/web/node_modules/@playwright/test'));
const sharp = require(path.resolve(__dirname, '../apps/api/node_modules/sharp'));

const BASE = 'http://localhost:5000/';
const OUT = path.resolve(__dirname, '../screenshots/mobile');
const SHOWCASE = process.env.SHOW_CODE || 'Q27DXGTU';
const OTHERS = (process.env.OTHER_CODES || '9B5M3A42,RBY6EMPM,T5XKHTZQ,94M4YWET').split(',');
fs.mkdirSync(OUT, { recursive: true });
let n = 0;
const TAB = { capture: [50, 835], uploads: [150, 835], gallery: [250, 835], mine: [350, 835] };

(async () => {
  const browser = await chromium.launch({ channel: 'msedge', args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
  const ctx = await browser.newContext({ viewport: { width: 400, height: 860 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, permissions: ['camera'] });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => console.log('  pageerror:', String(e).slice(0, 160)));
  const wait = (ms = 1500) => p.waitForTimeout(ms);
  const shot = async (name) => { n++; const f = `${String(n).padStart(2, '0')}-${name}.png`; await p.screenshot({ path: path.join(OUT, f) }); console.log('  ', f); };
  const sem = async () => { await p.evaluate(() => document.querySelector('flt-semantics-placeholder')?.click()); await wait(500); };
  const step = async (label, fn) => { try { await fn(); } catch (e) { console.log(`  ! ${label}: ${String(e.message).split('\n')[0].slice(0, 120)}`); } };
  const click = async (xy) => { await p.mouse.click(xy[0], xy[1]); };
  const back = async () => { await p.mouse.click(28, 28); await wait(1800); };
  const joinByCode = async (code, name) => {
    await p.getByRole('button', { name: /enter code/i }).first().click(); await wait(700);
    if (name) await shot(name + '-dialog');
    await p.getByRole('textbox').first().fill(code);
    await p.getByRole('button', { name: /continue/i }).click(); await wait(3200);
  };
  const consentAndJoin = async () => { await p.getByRole('checkbox').first().click(); await wait(300); await p.getByRole('button', { name: /^join event$/i }).click(); await wait(3500); };

  await p.goto(BASE, { waitUntil: 'networkidle' }); await wait(3000);
  console.log('Start');
  await shot('splash'); await sem();
  await p.getByRole('button', { name: /get started/i }).click(); await wait(1500);
  await shot('home-empty');
  await step('scanner', async () => { await p.getByRole('button', { name: /scan qr/i }).first().click(); await wait(3500); await shot('scan-qr-code'); await back(); });

  console.log('Join + event');
  await joinByCode(SHOWCASE, 'enter-code');
  await shot('join-event');
  await consentAndJoin();
  await shot('event-capture');

  await step('upload', async () => {
    const f = path.join(os.tmpdir(), 'mobile-showcase.jpg');
    await sharp(path.resolve(__dirname, '../apps/web/public/samples/party.jpg')).extract({ left: 300, top: 40, width: 700, height: 600 }).jpeg().toFile(f);
    const [fc] = await Promise.all([p.waitForEvent('filechooser'), p.getByRole('button', { name: /choose/i }).first().click()]);
    await fc.setFiles(f); await wait(1500); await shot('event-draft-photo');
    await p.getByRole('button', { name: /add to queue/i }).click(); await wait(6000);
    await click(TAB.uploads); await wait(1500); await shot('event-uploads-queue');
  });

  console.log('Gallery');
  await step('gallery', async () => {
    await click(TAB.gallery); await wait(4000); await shot('gallery-grid');
    for (const [name, label] of [['collage', /^Collage/], ['large', /^Large/], ['by-sender', /^By sender/], ['grid', /^Grid/]]) {
      if (name === 'grid') continue;
      await p.getByRole('button', { name: label }).click(); await wait(2500); await shot(`gallery-${name}`);
    }
    await p.getByRole('button', { name: /^Grid/ }).click(); await wait(1500);
    await p.locator('[aria-label^="People"]').first().click(); await wait(3500); await shot('gallery-people');
    await click([110, 260]); await wait(3000); await shot('gallery-one-person');
    await p.locator('[aria-label^="Highlights"]').first().click(); await wait(2500); await shot('gallery-highlights');
    await p.locator('[aria-label^="Yours"]').first().click(); await wait(3000); await shot('gallery-yours');
    await p.locator('[aria-label^="All"]').first().click(); await wait(3000);
    await click([75, 205]); await wait(2500); await shot('photo-viewer'); await back();
  });
  await step('mine', async () => { await click(TAB.mine); await wait(4000); await shot('event-mine'); });
  await step('menu', async () => { await click([380, 28]); await wait(700); await shot('event-menu'); await p.keyboard.press('Escape'); await wait(500); });
  await back();

  console.log('Home with several events');
  for (const code of OTHERS) await step('join ' + code, async () => { await joinByCode(code); await consentAndJoin(); await back(); });
  await wait(2500);
  await p.setViewportSize({ width: 400, height: 1300 }); await wait(1500);
  await shot('home-events'); await p.setViewportSize({ width: 400, height: 860 }); await wait(1000);

  console.log('Settings');
  await step('settings', async () => {
    await p.getByRole('button', { name: /settings/i }).first().click(); await wait(1800); await shot('settings');
  });
  // Amharic: the language dropdown is not exposed to the accessibility tree, so set the saved preference and reload.
  await step('amharic', async () => {
    await p.evaluate(() => localStorage.setItem('flutter.lang', JSON.stringify('am')));
    await p.reload({ waitUntil: 'networkidle' }); await wait(3500); await sem();
    await shot('home-amharic');
    await p.locator('flt-semantics[role="button"]').last().click().catch(() => {});
    await wait(1500); await shot('settings-amharic');
  });

  await browser.close();
  console.log(`Done: ${n} screenshots in ${OUT}`);
})();
