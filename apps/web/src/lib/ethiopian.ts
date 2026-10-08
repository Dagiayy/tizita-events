/**
 * Ethiopian calendar conversion for presentation and date entry (the API stores absolute UTC timestamps only).
 * Julian Day Number based; matches apps/api/src/common/ethiopic-calendar.ts and the Flutter app.
 */
const JDN_OFFSET = 1723856;
export const ET_MONTHS_EN = ['Meskerem', 'Tikimt', 'Hidar', 'Tahsas', 'Tir', 'Yekatit', 'Megabit', 'Miazia', 'Ginbot', 'Sene', 'Hamle', 'Nehase', 'Pagume'];
export const ET_MONTHS_AM = ['መስከረም', 'ጥቅምት', 'ኅዳር', 'ታኅሣሥ', 'ጥር', 'የካቲት', 'መጋቢት', 'ሚያዝያ', 'ግንቦት', 'ሰኔ', 'ሐምሌ', 'ነሐሴ', 'ጳጉሜን'];
export interface YMD { year: number; month: number; day: number }

const gToJdn = (y: number, m: number, d: number) => {
  const a = Math.floor((14 - m) / 12); const yy = y + 4800 - a; const mm = m + 12 * a - 3;
  return d + Math.floor((153 * mm + 2) / 5) + 365 * yy + Math.floor(yy / 4) - Math.floor(yy / 100) + Math.floor(yy / 400) - 32045;
};
const jdnToG = (jdn: number): YMD => {
  const a = jdn + 32044; const b = Math.floor((4 * a + 3) / 146097); const c = a - Math.floor((146097 * b) / 4);
  const d = Math.floor((4 * c + 3) / 1461); const e = c - Math.floor((1461 * d) / 4); const m = Math.floor((5 * e + 2) / 153);
  return { day: e - Math.floor((153 * m + 2) / 5) + 1, month: m + 3 - 12 * Math.floor(m / 10), year: 100 * b + d - 4800 + Math.floor(m / 10) };
};
export function gregorianToEthiopian(y: number, m: number, d: number): YMD {
  const jdn = gToJdn(y, m, d); const r = (jdn - JDN_OFFSET) % 1461; const n = (r % 365) + 365 * Math.floor(r / 1460);
  return { year: 4 * Math.floor((jdn - JDN_OFFSET) / 1461) + Math.floor(r / 365) - Math.floor(r / 1460), month: Math.floor(n / 30) + 1, day: (n % 30) + 1 };
}
export function ethiopianToGregorian(year: number, month: number, day: number): YMD {
  return jdnToG(JDN_OFFSET + 365 + 365 * (year - 1) + Math.floor(year / 4) + 30 * month + day - 31);
}
export const isEthiopianLeap = (y: number) => y % 4 === 3;
export const daysInEthiopianMonth = (y: number, m: number) => (m < 13 ? 30 : isEthiopianLeap(y) ? 6 : 5);

/** Local (Africa/Addis_Ababa, UTC+3, no DST) calendar parts of an instant. */
export function eatParts(d: Date): { y: number; m: number; d: number; hh: number; mm: number } {
  const t = new Date(d.getTime() + 3 * 3600_000);
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate(), hh: t.getUTCHours(), mm: t.getUTCMinutes() };
}
/** Build a UTC instant from an EAT wall-clock time. */
export function fromEat(y: number, m: number, d: number, hh = 0, mm = 0): Date {
  return new Date(Date.UTC(y, m - 1, d, hh - 3, mm));
}

export function formatDate(iso: string | Date, lang: 'en' | 'am', opts: { time?: boolean } = {}): { gregorian: string; ethiopian: string } {
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  const p = eatParts(d);
  const e = gregorianToEthiopian(p.y, p.m, p.d);
  const mon = (lang === 'am' ? ET_MONTHS_AM : ET_MONTHS_EN)[e.month - 1];
  const gMon = new Intl.DateTimeFormat(lang === 'am' ? 'am-ET' : 'en-GB', { month: 'long', timeZone: 'Africa/Addis_Ababa' }).format(d);
  const time = opts.time ? ` ${String(p.hh).padStart(2, '0')}:${String(p.mm).padStart(2, '0')}` : '';
  return { gregorian: `${p.d} ${gMon} ${p.y}${time}`, ethiopian: `${e.day} ${mon} ${e.year}${time}` };
}
