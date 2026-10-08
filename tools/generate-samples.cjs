/* Generates the built-in sample cover images, one per event type (used whenever a host has not uploaded their own cover).
 *   node tools/generate-samples.cjs
 * Output: apps/web/public/samples/<type>.jpg and apps/mobile/assets/samples/<type>.jpg (1280x720).
 * They are original, license-free illustrations rendered locally (no external images, nothing leaves the machine).
 * To use real photographs instead, just replace the .jpg files with the same names and sizes - no code change is needed. */
const path = require('path');
const fs = require('fs');
const sharp = require(path.resolve(__dirname, '../apps/api/node_modules/sharp'));

const W = 1600, H = 900;
let seedState = 1;
const rnd = () => { seedState = (seedState * 1664525 + 1013904223) >>> 0; return seedState / 4294967296; };
const R = (a, b) => a + rnd() * (b - a);
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
const f = (n) => Math.round(n * 10) / 10;

const DEFS = `<defs>
  <filter id="b3" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="3"/></filter>
  <filter id="b8" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="8"/></filter>
  <filter id="b18" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="18"/></filter>
  <filter id="b40" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="40"/></filter>
  <filter id="grain" x="0" y="0" width="100%" height="100%"><feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" seed="3"/><feColorMatrix type="saturate" values="0"/></filter>
  <radialGradient id="vig" cx="50%" cy="48%" r="75%"><stop offset="55%" stop-color="#000" stop-opacity="0"/><stop offset="100%" stop-color="#000" stop-opacity=".55"/></radialGradient>
</defs>`;

const sky = (stops) => `<linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">${stops.map(([o, c]) => `<stop offset="${o}" stop-color="${c}"/>`).join('')}</linearGradient><rect width="${W}" height="${H}" fill="url(#sky)"/>`;
const skyDef = (stops) => `<defs><linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">${stops.map(([o, c]) => `<stop offset="${o}" stop-color="${c}"/>`).join('')}</linearGradient></defs><rect width="${W}" height="${H}" fill="url(#sky)"/>`;

function bokeh(n, colors, y0 = 0, y1 = H, rMin = 14, rMax = 60, op = [0.12, 0.4]) {
  let s = '';
  for (let i = 0; i < n; i++) s += `<circle cx="${f(R(0, W))}" cy="${f(R(y0, y1))}" r="${f(R(rMin, rMax))}" fill="${pick(colors)}" opacity="${f(R(op[0], op[1]))}" filter="url(#b${rnd() > 0.5 ? 3 : 8})"/>`;
  return s;
}

/** A sagging string of lights between two points, with glowing bulbs. */
function lights(x0, y0, x1, y1, sag, n, color = '#ffe2a0') {
  const mx = (x0 + x1) / 2, my = (y0 + y1) / 2 + sag * 2;
  let s = `<path d="M${x0} ${y0} Q${mx} ${my} ${x1} ${y1}" stroke="#1a1020" stroke-width="2" fill="none" opacity=".8"/>`;
  for (let i = 0; i <= n; i++) {
    const t = i / n, x = (1 - t) * (1 - t) * x0 + 2 * (1 - t) * t * mx + t * t * x1, y = (1 - t) * (1 - t) * y0 + 2 * (1 - t) * t * my + t * t * y1;
    s += `<circle cx="${f(x)}" cy="${f(y + 8)}" r="16" fill="${color}" opacity=".55" filter="url(#b8)"/><circle cx="${f(x)}" cy="${f(y + 8)}" r="4.5" fill="#fff6dc"/>`;
  }
  return s;
}

/** Silhouette crowd along the bottom edge; `arms` raises some hands (some holding a glowing phone). */
function crowd(baseY, color, count, scale = 1, arms = 0.25) {
  let s = '';
  const step = W / count;
  for (let i = 0; i < count + 2; i++) {
    const cx = i * step + R(-step * 0.3, step * 0.3), hr = R(26, 38) * scale, cy = baseY - R(0, 70) * scale;
    s += `<path d="M${f(cx - hr * 2)} ${H + 10} Q${f(cx - hr * 2)} ${f(cy + hr * 1.4)} ${f(cx)} ${f(cy + hr * 1.2)} Q${f(cx + hr * 2)} ${f(cy + hr * 1.4)} ${f(cx + hr * 2)} ${H + 10}Z" fill="${color}"/>`;
    s += `<circle cx="${f(cx)}" cy="${f(cy)}" r="${f(hr)}" fill="${color}"/>`;
    if (rnd() < arms) {
      const side = rnd() > 0.5 ? 1 : -1, ax = cx + side * hr * 1.7, ay = cy - hr * 2.4;
      s += `<path d="M${f(cx + side * hr * 1.2)} ${f(cy + hr * 1.5)} L${f(ax)} ${f(ay)}" stroke="${color}" stroke-width="${f(hr * 0.5)}" stroke-linecap="round"/>`;
      if (rnd() < 0.5) s += `<rect x="${f(ax - 9)}" y="${f(ay - 22)}" width="18" height="28" rx="3" fill="${color}"/><rect x="${f(ax - 6)}" y="${f(ay - 18)}" width="12" height="20" rx="2" fill="#bfe3ff" opacity=".85"/>`;
    }
  }
  return s;
}

const balloon = (cx, cy, rx, ry, c) =>
  `<path d="M${f(cx)} ${f(cy + ry + 40)} Q${f(cx + R(-25, 25))} ${f(cy + ry + 130)} ${f(cx + R(-20, 20))} ${f(cy + ry + 220)}" stroke="#ffffff" stroke-opacity=".55" stroke-width="2" fill="none"/>` +
  `<ellipse cx="${f(cx)}" cy="${f(cy)}" rx="${rx}" ry="${ry}" fill="${c}"/><ellipse cx="${f(cx - rx * 0.35)}" cy="${f(cy - ry * 0.35)}" rx="${f(rx * 0.22)}" ry="${f(ry * 0.3)}" fill="#fff" opacity=".45"/>` +
  `<path d="M${f(cx - 8)} ${f(cy + ry + 8)} L${f(cx)} ${f(cy + ry - 4)} L${f(cx + 8)} ${f(cy + ry + 8)}Z" fill="${c}"/>`;

const cap = (cx, cy, size, rot) => {
  const s = size;
  return `<g transform="translate(${f(cx)} ${f(cy)}) rotate(${rot})"><path d="M${-s * 0.55} ${s * 0.12} L${-s * 0.55} ${s * 0.52} Q0 ${s * 0.78} ${s * 0.55} ${s * 0.52} L${s * 0.55} ${s * 0.12}Z" fill="#101a3f"/><path d="M${-s * 1.2} 0 L0 ${-s * 0.42} L${s * 1.2} 0 L0 ${s * 0.42}Z" fill="#17235a"/><path d="M0 0 L${s * 0.95} ${s * 0.25} L${s * 0.95} ${s * 0.75}" stroke="#f2b632" stroke-width="${f(s * 0.07)}" fill="none"/><circle cx="${s * 0.95}" cy="${s * 0.78}" r="${f(s * 0.1)}" fill="#f2b632"/></g>`;
};

const building = (x, w, h, base, tone) => {
  let s = `<rect x="${x}" y="${base - h}" width="${w}" height="${h}" fill="${tone}"/>`;
  for (let wy = base - h + 16; wy < base - 14; wy += 22) for (let wx = x + 10; wx < x + w - 14; wx += 18) if (rnd() > 0.42) s += `<rect x="${wx}" y="${wy}" width="9" height="13" fill="${pick(['#ffd98a', '#ffe9b8', '#9fd6ff'])}" opacity="${f(R(0.55, 0.95))}"/>`;
  return s;
};

const SCENES = {
  wedding() {
    let s = skyDef([[0, '#2b2347'], [0.35, '#b8647a'], [0.7, '#f4b184'], [1, '#ffe3c0']]);
    s += `<circle cx="${W * 0.5}" cy="${H * 0.56}" r="330" fill="#ffd9a8" opacity=".55" filter="url(#b40)"/>`;
    s += bokeh(34, ['#fff0c4', '#ffd4e1', '#ffe4b3'], 60, 700, 14, 52, [0.15, 0.5]);
    s += lights(-20, 90, W + 20, 120, 70, 26) + lights(-20, 160, W + 20, 170, 55, 22);
    // floral arch
    const cx = W / 2, base = 790, rx = 300, ry = 520;
    s += `<path d="M${cx - rx} ${base} A${rx} ${ry} 0 0 1 ${cx + rx} ${base}" stroke="#3b2a2a" stroke-width="12" fill="none" opacity=".85"/>`;
    for (let i = 0; i < 70; i++) {
      const a = Math.PI * (i / 69), x = cx - Math.cos(a) * rx + R(-26, 26), y = base - Math.sin(a) * ry + R(-26, 26);
      s += `<circle cx="${f(x)}" cy="${f(y)}" r="${f(R(14, 30))}" fill="${pick(['#ffffff', '#ffd1dc', '#f8a8bf', '#fff1e0', '#f4c2c2'])}"/>`;
      if (i % 3 === 0) s += `<ellipse cx="${f(x + R(-30, 30))}" cy="${f(y + R(-30, 30))}" rx="22" ry="9" fill="#3f7a4d" transform="rotate(${f(R(0, 180))} ${f(x)} ${f(y)})"/>`;
    }
    // couple
    s += `<path d="M${cx - 70} ${base} L${cx - 20} ${base - 250} L${cx + 14} ${base - 250} L${cx + 70} ${base}Z" fill="#fff6ee"/><circle cx="${cx - 3}" cy="${base - 285}" r="30" fill="#2a1a1a"/>`;
    s += `<rect x="${cx + 62}" y="${base - 265}" width="58" height="265" rx="10" fill="#17142a"/><circle cx="${cx + 91}" cy="${base - 300}" r="30" fill="#2a1a1a"/>`;
    s += `<rect x="0" y="${base}" width="${W}" height="${H - base}" fill="#2a1830"/>` + crowd(H - 20, '#150d1c', 22, 0.8, 0.15);
    return s;
  },
  birthday() {
    let s = skyDef([[0, '#6a3dff'], [0.45, '#ff7ab6'], [1, '#ffd08a']]);
    s += bokeh(30, ['#ffffff', '#ffe27a', '#8ef5ff'], 0, H, 14, 50, [0.12, 0.35]);
    const cols = ['#ff4d6d', '#ffd23f', '#3ddc97', '#3aa0ff', '#b86bff', '#ff8c42'];
    for (let i = 0; i < 16; i++) s += balloon(R(80, W - 80), R(90, 480), R(46, 70), R(58, 86), pick(cols));
    for (let i = 0; i < 160; i++) s += `<rect x="${f(R(0, W))}" y="${f(R(0, H))}" width="${f(R(6, 14))}" height="${f(R(4, 8))}" fill="${pick(cols)}" opacity=".85" transform="rotate(${f(R(0, 360))} ${f(R(0, W))} ${f(R(0, H))})"/>`;
    // cake
    const cx = W / 2, by = 820;
    s += `<ellipse cx="${cx}" cy="${by + 30}" rx="330" ry="26" fill="#000" opacity=".25" filter="url(#b8)"/>`;
    s += `<rect x="${cx - 260}" y="${by - 120}" width="520" height="140" rx="26" fill="#fff2e6"/><rect x="${cx - 260}" y="${by - 120}" width="520" height="40" rx="20" fill="#ff6fa5"/>`;
    s += `<rect x="${cx - 180}" y="${by - 230}" width="360" height="120" rx="24" fill="#ffe3cf"/><rect x="${cx - 180}" y="${by - 230}" width="360" height="34" rx="17" fill="#ffd23f"/>`;
    for (let i = -2; i <= 2; i++) s += `<rect x="${cx + i * 60 - 6}" y="${by - 290}" width="12" height="60" rx="3" fill="${pick(cols)}"/><ellipse cx="${cx + i * 60}" cy="${by - 305}" rx="8" ry="15" fill="#ffd36a"/><ellipse cx="${cx + i * 60}" cy="${by - 308}" rx="26" ry="34" fill="#ffd36a" opacity=".5" filter="url(#b8)"/>`;
    return s;
  },
  graduation() {
    let s = skyDef([[0, '#0f1b4d'], [0.45, '#3a3f93'], [0.75, '#d98a4a'], [1, '#ffd58a']]);
    s += `<circle cx="${W / 2}" cy="${H * 0.62}" r="380" fill="#ffd58a" opacity=".5" filter="url(#b40)"/>`;
    s += bokeh(26, ['#ffe9b0', '#ffffff'], 40, 560, 12, 40, [0.12, 0.4]);
    for (let i = 0; i < 22; i++) s += cap(R(80, W - 80), R(70, 430), R(34, 74), R(-35, 35));
    // stage light beams
    for (const x of [260, 800, 1340]) s += `<path d="M${x} 0 L${x - 190} ${H} L${x + 190} ${H}Z" fill="#fff3c9" opacity=".08" filter="url(#b18)"/>`;
    // graduates with caps
    for (let i = 0; i < 17; i++) {
      const cx = 40 + i * 98 + R(-18, 18), cy = H - R(100, 190), hr = R(30, 40);
      s += `<path d="M${f(cx - hr * 2)} ${H + 10} Q${f(cx - hr * 2)} ${f(cy + hr * 1.4)} ${f(cx)} ${f(cy + hr * 1.2)} Q${f(cx + hr * 2)} ${f(cy + hr * 1.4)} ${f(cx + hr * 2)} ${H + 10}Z" fill="#0a0a1e"/><circle cx="${f(cx)}" cy="${f(cy)}" r="${f(hr)}" fill="#0a0a1e"/>`;
      s += `<path d="M${f(cx - hr * 1.5)} ${f(cy - hr * 0.85)} L${f(cx)} ${f(cy - hr * 1.5)} L${f(cx + hr * 1.5)} ${f(cy - hr * 0.85)} L${f(cx)} ${f(cy - hr * 0.2)}Z" fill="#05050f"/>`;
    }
    return s;
  },
  conference() {
    let s = skyDef([[0, '#070b24'], [0.5, '#1b1760'], [1, '#2b1a55']]);
    // LED wall
    const sx = 330, sy = 120, sw = 940, sh = 400;
    s += `<rect x="${sx - 30}" y="${sy - 30}" width="${sw + 60}" height="${sh + 60}" rx="24" fill="#6c7bff" opacity=".35" filter="url(#b40)"/>`;
    s += `<rect x="${sx}" y="${sy}" width="${sw}" height="${sh}" rx="14" fill="#0e1442"/><rect x="${sx}" y="${sy}" width="${sw}" height="${sh}" rx="14" fill="url(#scr)"/>`;
    s = s.replace('</defs>', '<linearGradient id="scr" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#2d5bff"/><stop offset="1" stop-color="#b13cff"/></linearGradient></defs>');
    s += `<rect x="${sx + 70}" y="${sy + 90}" width="520" height="46" rx="12" fill="#fff" opacity=".92"/><rect x="${sx + 70}" y="${sy + 160}" width="360" height="26" rx="10" fill="#fff" opacity=".6"/><rect x="${sx + 70}" y="${sy + 210}" width="420" height="26" rx="10" fill="#fff" opacity=".4"/>`;
    s += `<circle cx="${sx + sw - 170}" cy="${sy + sh / 2}" r="110" fill="#fff" opacity=".18"/><circle cx="${sx + sw - 170}" cy="${sy + sh / 2}" r="62" fill="#fff" opacity=".28"/>`;
    for (const x of [140, 560, 1040, 1460]) s += `<path d="M${x} 0 L${x - 220} ${H} L${x + 220} ${H}Z" fill="${pick(['#ff4fd8', '#4fa8ff', '#8f6bff'])}" opacity=".13" filter="url(#b18)"/>`;
    s += bokeh(20, ['#7aa2ff', '#ff7ae0', '#ffffff'], 60, 600, 10, 34, [0.1, 0.35]);
    s += crowd(H - 60, '#05061a', 17, 1, 0.35);
    return s;
  },
  corporate() {
    let s = skyDef([[0, '#12304f'], [0.45, '#3f7a96'], [0.78, '#f2a65a'], [1, '#ffd9a0']]);
    s += `<circle cx="1180" cy="520" r="220" fill="#ffd9a0" opacity=".6" filter="url(#b40)"/>`;
    const base = H;
    for (let i = 0, x = -20; x < W; i++) { const w = R(90, 190), h = R(260, 700); s += building(x, w, h, base, pick(['#14283c', '#1a3550', '#102132'])); x += w + R(4, 22); }
    for (let i = 0, x = 10; x < W; i++) { const w = R(70, 140), h = R(120, 360); s += building(x, w, h, base, pick(['#0a1623', '#0d1b2c'])); x += w + R(10, 40); }
    s += `<rect x="0" y="${H - 90}" width="${W}" height="90" fill="#060d16"/>` + crowd(H - 10, '#03070d', 18, 0.7, 0.1);
    return s;
  },
  party() {
    let s = skyDef([[0, '#12041f'], [0.5, '#3a0a52'], [1, '#13062a']]);
    for (const [x, c] of [[200, '#ff2fb3'], [620, '#35e0ff'], [1000, '#9b5bff'], [1400, '#ff7a2f']]) s += `<path d="M${x} 0 L${x - 260} ${H} L${x + 260} ${H}Z" fill="${c}" opacity=".18" filter="url(#b18)"/>`;
    // disco ball
    const bx = W / 2, by = 190, br = 92;
    s += `<path d="M${bx} 0 L${bx} ${by - br}" stroke="#ccc" stroke-width="3"/><circle cx="${bx}" cy="${by}" r="${br + 70}" fill="#fff" opacity=".18" filter="url(#b40)"/><circle cx="${bx}" cy="${by}" r="${br}" fill="#b9c2d6"/>`;
    for (let i = 0; i < 70; i++) { const a = R(0, 6.28), d = R(0, br - 8); s += `<rect x="${f(bx + Math.cos(a) * d - 8)}" y="${f(by + Math.sin(a) * d - 8)}" width="16" height="16" fill="${pick(['#ffffff', '#ff6fd8', '#6fe6ff', '#c9a7ff', '#8a93a8'])}" opacity="${f(R(0.5, 1))}"/>`; }
    s += bokeh(40, ['#ff2fb3', '#35e0ff', '#9b5bff', '#ffd23f'], 0, H, 16, 56, [0.12, 0.45]);
    for (let i = 0; i < 40; i++) s += `<circle cx="${f(R(0, W))}" cy="${f(R(0, 500))}" r="3" fill="#fff" opacity="${f(R(0.5, 1))}"/>`;
    s += crowd(H - 70, '#07020f', 15, 1.15, 0.55);
    return s;
  },
  family() {
    let s = skyDef([[0, '#7fb6d9'], [0.4, '#f6c58a'], [0.75, '#f0925a'], [1, '#4b7a4a']]);
    s += `<circle cx="1220" cy="420" r="130" fill="#fff0c4"/><circle cx="1220" cy="420" r="260" fill="#ffe3a0" opacity=".5" filter="url(#b40)"/>`;
    // hills + trees
    s += `<path d="M0 560 Q400 440 800 540 T1600 500 L1600 900 L0 900Z" fill="#5d8d52"/><path d="M0 660 Q500 560 1000 650 T1600 620 L1600 900 L0 900Z" fill="#3f7040"/>`;
    for (const [x, y, r] of [[170, 470, 110], [330, 500, 80], [1450, 450, 120], [1290, 520, 80]]) s += `<rect x="${x - 12}" y="${y}" width="24" height="150" fill="#4a2f22"/><circle cx="${x}" cy="${y - 10}" r="${r}" fill="#2f6a3a"/><circle cx="${x - r * 0.4}" cy="${y - r * 0.2}" r="${r * 0.6}" fill="#3c8048"/>`;
    s += lights(-20, 150, W + 20, 200, 80, 24, '#fff0b0') + bokeh(18, ['#fff0b0', '#ffd2a0'], 100, 500, 12, 38, [0.1, 0.3]);
    // blanket + family
    s += `<path d="M300 800 L1300 800 L1420 900 L180 900Z" fill="#c84b4b"/>`;
    for (let i = 0; i < 9; i++) s += `<path d="M${300 + i * 125} 800 L${180 + i * 138} 900" stroke="#fff" stroke-width="10" opacity=".6"/>`;
    const fam = [[520, 690, 44, 150, '#25203a'], [650, 700, 44, 140, '#3a2538'], [770, 745, 28, 80, '#1d2d3f'], [870, 750, 26, 74, '#3f2a2a'], [990, 690, 44, 150, '#1f2f2a']];
    for (const [x, y, r, h, c] of fam) s += `<rect x="${x - r}" y="${y + r}" width="${r * 2}" height="${h}" rx="${r * 0.7}" fill="${c}"/><circle cx="${x}" cy="${y}" r="${r}" fill="${c}"/>`;
    return s;
  },
  cultural() {
    let s = skyDef([[0, '#0b2e1f'], [0.4, '#2f6a2e'], [0.7, '#e2a21a'], [1, '#c0392b']]);
    s += `<circle cx="${W / 2}" cy="${H * 0.6}" r="320" fill="#ffd66b" opacity=".45" filter="url(#b40)"/>`;
    // traditional geometric band (top and bottom)
    for (const y of [0, H - 56]) { s += `<rect x="0" y="${y}" width="${W}" height="56" fill="#7a1d12"/>`; for (let x = 0; x < W; x += 56) s += `<path d="M${x} ${y + 28} L${x + 28} ${y + 4} L${x + 56} ${y + 28} L${x + 28} ${y + 52}Z" fill="#f2b632"/><path d="M${x + 14} ${y + 28} L${x + 28} ${y + 14} L${x + 42} ${y + 28} L${x + 28} ${y + 42}Z" fill="#1f7a3a"/>`; }
    // hanging lanterns
    for (let i = 0; i < 11; i++) { const x = 90 + i * 142 + R(-20, 20), len = R(120, 330); s += `<path d="M${x} 56 L${x} ${len}" stroke="#2a1a10" stroke-width="2"/><ellipse cx="${x}" cy="${len + 40}" rx="44" ry="58" fill="${pick(['#ff9d2e', '#ffcf4a', '#e4572e'])}"/><ellipse cx="${x}" cy="${len + 40}" rx="70" ry="86" fill="#ffb347" opacity=".35" filter="url(#b18)"/><path d="M${x - 44} ${len + 40} Q${x} ${len + 20} ${x + 44} ${len + 40}" stroke="#7a1d12" stroke-width="3" fill="none"/>`; }
    s += bokeh(22, ['#ffe08a', '#ffffff'], 300, 700, 12, 40, [0.1, 0.35]);
    s += crowd(H - 56, '#120a06', 17, 0.95, 0.3);
    return s;
  },
  other() {
    let s = skyDef([[0, '#120d2b'], [0.34, '#3b1d5a'], [0.62, '#b2406a'], [0.86, '#f08a4b'], [1, '#ffc27a']]);
    s += `<circle cx="${W / 2}" cy="${H * 0.66}" r="360" fill="#ff9a5a" opacity=".5" filter="url(#b40)"/>`;
    s += bokeh(36, ['#ffe2a0', '#ffb36b', '#ff8fb0'], 40, 700, 12, 48, [0.12, 0.42]);
    s += lights(-20, 120, W + 20, 150, 90, 26) + lights(-20, 220, W + 20, 230, 70, 24) + lights(200, 70, W + 20, 70, 50, 14);
    s += crowd(H - 40, '#0b0716', 20, 1, 0.3);
    return s;
  },
};

async function render(name) {
  seedState = [...name].reduce((n, c) => (n * 31 + c.charCodeAt(0)) >>> 0, 7);
  const body = SCENES[name]();
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${DEFS}${body}<rect width="${W}" height="${H}" fill="url(#vig)"/><rect width="${W}" height="${H}" filter="url(#grain)" opacity=".07"/></svg>`;
  return sharp(Buffer.from(svg)).resize(1280, 720).jpeg({ quality: 84, mozjpeg: true }).toBuffer();
}

(async () => {
  const outs = [path.resolve(__dirname, '../apps/web/public/samples'), path.resolve(__dirname, '../apps/mobile/assets/samples')];
  for (const o of outs) fs.mkdirSync(o, { recursive: true });
  for (const name of Object.keys(SCENES)) {
    const buf = await render(name);
    for (const o of outs) fs.writeFileSync(path.join(o, `${name}.jpg`), buf);
    console.log(name, Math.round(buf.length / 1024) + ' KB');
  }
})();
