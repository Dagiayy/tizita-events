/**
 * Ethiopian calendar conversion (Gregorian <-> Ethiopian) via Julian Day Number.
 * The platform persists absolute UTC timestamps; this only affects presentation / date entry.
 * Ethiopian year has 12 months of 30 days + Pagume (5 or 6 days).
 */
const JDN_EPOCH_OFFSET = 1723856; // JDN of Ethiopian 1/1/1 (Meskerem 1, year 1)

export const ETHIOPIAN_MONTHS_EN = ['Meskerem', 'Tikimt', 'Hidar', 'Tahsas', 'Tir', 'Yekatit', 'Megabit', 'Miazia', 'Ginbot', 'Sene', 'Hamle', 'Nehase', 'Pagume'];
export const ETHIOPIAN_MONTHS_AM = ['መስከረም', 'ጥቅምት', 'ኅዳር', 'ታኅሣሥ', 'ጥር', 'የካቲት', 'መጋቢት', 'ሚያዝያ', 'ግንቦት', 'ሰኔ', 'ሐምሌ', 'ነሐሴ', 'ጳጉሜን'];

export interface EthiopianDate { year: number; month: number; day: number }

export function gregorianToJdn(y: number, m: number, d: number): number {
  const a = Math.floor((14 - m) / 12);
  const yy = y + 4800 - a;
  const mm = m + 12 * a - 3;
  return d + Math.floor((153 * mm + 2) / 5) + 365 * yy + Math.floor(yy / 4) - Math.floor(yy / 100) + Math.floor(yy / 400) - 32045;
}
export function jdnToGregorian(jdn: number): { year: number; month: number; day: number } {
  const a = jdn + 32044;
  const b = Math.floor((4 * a + 3) / 146097);
  const c = a - Math.floor((146097 * b) / 4);
  const d = Math.floor((4 * c + 3) / 1461);
  const e = c - Math.floor((1461 * d) / 4);
  const m = Math.floor((5 * e + 2) / 153);
  return { day: e - Math.floor((153 * m + 2) / 5) + 1, month: m + 3 - 12 * Math.floor(m / 10), year: 100 * b + d - 4800 + Math.floor(m / 10) };
}

export function gregorianToEthiopian(y: number, m: number, d: number): EthiopianDate {
  const r = (gregorianToJdn(y, m, d) - JDN_EPOCH_OFFSET) % 1461;
  const n = (r % 365) + 365 * Math.floor(r / 1460);
  const year = 4 * Math.floor((gregorianToJdn(y, m, d) - JDN_EPOCH_OFFSET) / 1461) + Math.floor(r / 365) - Math.floor(r / 1460);
  return { year, month: Math.floor(n / 30) + 1, day: (n % 30) + 1 };
}
export function ethiopianToGregorian(year: number, month: number, day: number): { year: number; month: number; day: number } {
  const jdn = JDN_EPOCH_OFFSET + 365 + 365 * (year - 1) + Math.floor(year / 4) + 30 * month + day - 31;
  return jdnToGregorian(jdn);
}
export const isEthiopianLeapYear = (y: number): boolean => y % 4 === 3;
