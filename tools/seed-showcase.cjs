/* Creates a "showcase" event with photo-like content for demos/screenshots:
 *   node tools/seed-showcase.cjs            (API on :4000, OTP_FIXED_CODE=123456)
 * Photos are crops of the built-in sample pictures, uploaded by several named guests and approved by the host. */
const path = require('path');
const sharp = require(path.resolve(__dirname, '../apps/api/node_modules/sharp'));
const API = process.env.API || 'http://localhost:4000/v1';
const HOST = process.env.SHOWCASE_HOST || '0911000009';
const NAME = process.env.SHOWCASE_NAME || 'Addis Tech Summit 2026';
const call = async (m, p, t, b, h = {}) => {
  const r = await fetch(API + p, { method: m, headers: { 'content-type': 'application/json', ...(t ? { authorization: `Bearer ${t}` } : {}), ...h }, body: b ? JSON.stringify(b) : undefined });
  const x = await r.text(); return { status: r.status, body: x ? JSON.parse(x) : {} };
};
const types = ['conference', 'party', 'graduation', 'wedding', 'cultural', 'corporate', 'birthday', 'family', 'other'];
let s = 7; const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
const crop = async (i) => {
  const src = path.resolve(__dirname, `../apps/web/public/samples/${types[i % types.length]}.jpg`);
  const [w, h] = [[900, 600], [600, 900], [800, 800], [1000, 560]][i % 4];
  const sw = Math.round(1280 * (0.45 + rnd() * 0.45)), sh = Math.min(720, Math.round(sw * h / w));
  const left = Math.floor(rnd() * (1280 - sw)), top = Math.floor(rnd() * (720 - sh));
  return sharp(src).extract({ left, top, width: sw, height: sh }).resize(w, h).modulate({ brightness: 0.9 + rnd() * 0.3, saturation: 0.9 + rnd() * 0.4 }).jpeg({ quality: 84 }).toBuffer();
};
(async () => {
  await call('POST', '/auth/request-otp', null, { phone: HOST });
  const host = (await call('POST', '/auth/verify-otp', null, { phone: HOST, code: '123456' })).body.access_token;
  let ev = (await call('GET', '/events', host)).body.events.find((e) => e.name === NAME);
  const now = Date.now();
  if (!ev) {
    const c = await call('POST', '/events', host, { name: NAME, type: 'conference', city: 'Addis Ababa', venue: 'Millennium Hall', language: 'en', host_name: 'Selam T.', starts_at: new Date(now - 3600e3).toISOString(), ends_at: new Date(now + 8 * 3600e3).toISOString(), upload_closes_at: new Date(now + 24 * 3600e3).toISOString(), join_code_scope: 'both', captions_enabled: true });
    if (c.status !== 201) throw new Error('create ' + JSON.stringify(c.body));
    await call('POST', `/events/${c.body.id}/activate-trial`, host, {});
    ev = c.body;
  }
  const links = (await call('GET', `/events/${ev.id}/share-links`, host)).body;
  const ctx = (await call('GET', `/events/${links.join_code}/context?lang=en`)).body;
  const people = [['Selam T.', 7], ['Abebe K.', 5], ['Meron G.', 6], ['Dawit M.', 4], ['Hana B.', 5]];
  const captions = ['Opening keynote', 'Great panel!', 'Networking break', 'Demo booth', 'Full house', 'Team photo', 'Closing remarks', 'Coffee time'];
  let n = 0;
  for (const [name, count] of people) {
    const j = await call('POST', `/events/${links.join_code}/join`, null, { display_name: name, device_id: 'showcase-' + name, consent: { notice_version: ctx.notice.version, accepted: true } });
    for (let i = 0; i < count; i++) {
      n++;
      const buf = await crop(n);
      const it = await call('POST', '/guest/uploads/intents', j.body.token, { mime: 'image/jpeg', size: buf.length, caption: captions[n % captions.length] }, { 'Idempotency-Key': `showcase-intent-${ev.id.slice(0, 8)}-${n}` });
      if (it.status !== 200) { console.log('intent', it.status, JSON.stringify(it.body).slice(0, 100)); continue; }
      const up = it.body.upload;
      for (let c = 0; c < up.total_chunks; c++) await fetch(`${API}/uploads/${it.body.media_id}/chunks/${c}`, { method: 'PUT', headers: { 'X-Upload-Token': up.token, 'content-type': 'application/octet-stream' }, body: buf.subarray(c * up.chunk_bytes, (c + 1) * up.chunk_bytes) });
      await call('POST', `/media/${it.body.media_id}/complete`, null, undefined, { 'X-Upload-Token': up.token, 'Idempotency-Key': `showcase-done-${ev.id.slice(0, 8)}-${n}` });
    }
    console.log('uploaded', count, 'for', name);
  }
  await new Promise((r) => setTimeout(r, 15000));
  const q = await call('GET', `/events/${ev.id}/moderation`, host);
  const ids = (q.body.items || []).map((i) => i.id);
  // leave two photos pending so the moderation screens have something to show
  const approve = ids.slice(2);
  if (approve.length) console.log('approved', approve.length, (await call('POST', `/events/${ev.id}/moderation/bulk`, host, { action: 'approve', media_ids: approve })).status);
  console.log(JSON.stringify({ id: ev.id, join_code: links.join_code, guest_link: links.upload_url, gallery_link: links.gallery_url, slideshow: links.slideshow_url }, null, 1));
})();
