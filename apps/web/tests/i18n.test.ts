import { describe, expect, it } from 'vitest';
import en from '../src/locales/en.json';
import am from '../src/locales/am.json';
import { translate, errorMessage } from '../src/lib/i18n';
import { formatDate, gregorianToEthiopian, ethiopianToGregorian, fromEat, eatParts, daysInEthiopianMonth } from '../src/lib/ethiopian';

const ETHIOPIC = /[ሀ-፿]/;
const vars = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe('localization resources (acceptance #23, #24, #25)', () => {
  it('English and Amharic define exactly the same keys', () => {
    expect(Object.keys(am).sort()).toEqual(Object.keys(en).sort());
  });
  it('no empty strings; interpolation variables match across languages', () => {
    for (const [k, v] of Object.entries(en)) {
      expect(v.trim().length, k).toBeGreaterThan(0);
      expect((am as Record<string, string>)[k].trim().length, k).toBeGreaterThan(0);
      expect(vars((am as Record<string, string>)[k]), `variables in ${k}`).toEqual(vars(v));
    }
  });
  it('Amharic strings are actually Amharic (Ethiopic script) except for brands/units', () => {
    const allowedLatin = new Set(['host.share.png', 'host.share.pdf', 'common.close.esc']);
    let latinOnly = 0;
    for (const [k, v] of Object.entries(am)) if (!ETHIOPIC.test(v) && !allowedLatin.has(k)) { latinOnly++; }
    expect(latinOnly).toBe(0);
  });
  it('translate() interpolates, falls back to English, then to the key', () => {
    expect(translate('en', 'guest.preview.count', { n: 3 })).toBe('3 photo(s) selected');
    expect(translate('am', 'guest.preview.count', { n: 3 })).toContain('3');
    expect(translate('am', 'guest.home.takePhoto')).toBe('ፎቶ ያንሱ');
    expect(translate('am', 'does.not.exist')).toBe('does.not.exist');
  });
  it('API error codes map to localized messages with a safe fallback', () => {
    const t = (k: string, v?: Record<string, string | number>) => translate('am', k, v);
    expect(errorMessage(t, 'otp_invalid')).toBe(am['err.otp_invalid']);
    expect(errorMessage(t, 'something_new')).toBe(am['err.generic']);
    expect(errorMessage(t, undefined)).toBe(am['err.generic']);
  });
  it('every error code the API can return to guests has a message in both languages', () => {
    for (const code of ['rate_limited', 'otp_invalid', 'event_not_found', 'credential_required', 'consent_required', 'name_required', 'file_too_large', 'unsupported_type', 'event_storage_full', 'event_media_limit', 'outside_upload_window', 'session_blocked', 'link_expired', 'downloads_disabled'])
      for (const d of [en, am] as Record<string, string>[]) expect(d[`err.${code}`], code).toBeTruthy();
  });
});

describe('Ethiopian calendar presentation (EAT)', () => {
  it('converts known dates', () => {
    expect(gregorianToEthiopian(2026, 9, 11)).toEqual({ year: 2019, month: 1, day: 1 });
    expect(gregorianToEthiopian(2026, 10, 2)).toEqual({ year: 2019, month: 1, day: 22 });
    expect(ethiopianToGregorian(2016, 1, 1)).toEqual({ year: 2023, month: 9, day: 12 });
    expect(daysInEthiopianMonth(2015, 13)).toBe(6); expect(daysInEthiopianMonth(2016, 13)).toBe(5);
  });
  it('round-trips', () => {
    for (let d = 0; d < 3000; d += 11) {
      const g = new Date(Date.UTC(2016, 0, 1) + d * 86400000);
      const e = gregorianToEthiopian(g.getUTCFullYear(), g.getUTCMonth() + 1, g.getUTCDate());
      expect(ethiopianToGregorian(e.year, e.month, e.day)).toEqual({ year: g.getUTCFullYear(), month: g.getUTCMonth() + 1, day: g.getUTCDate() });
    }
  });
  it('EAT wall-clock handling is UTC+3 with no DST and survives midnight boundaries', () => {
    const d = fromEat(2026, 10, 2, 0, 30);                       // 00:30 EAT on 2 Oct == 21:30 UTC on 1 Oct
    expect(d.toISOString()).toBe('2026-10-01T21:30:00.000Z');
    expect(eatParts(d)).toEqual({ y: 2026, m: 10, d: 2, hh: 0, mm: 30 });
    const f = formatDate('2026-10-01T21:30:00Z', 'en', { time: true });
    expect(f.gregorian).toContain('2 October 2026'); expect(f.gregorian).toContain('00:30'); expect(f.ethiopian).toContain('Meskerem 2019');
    const a = formatDate('2026-10-01T21:30:00Z', 'am');
    expect(a.ethiopian).toBe('22 መስከረም 2019');
  });
});
