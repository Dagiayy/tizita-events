import { totpAt, totpVerify, base32Encode, sha256Hex, CryptoService, randomFromAlphabet, JOIN_CODE_ALPHABET } from '../../src/common/crypto';
import { normalizeEthiopianPhone, normalizeGuestPhone, displayLocal } from '../../src/common/phone';
import { ethiopianToGregorian, gregorianToEthiopian, isEthiopianLeapYear } from '../../src/common/ethiopic-calendar';
import { assertAllowed, canTransition, stateAllows, stateFromClock, allowedActions, EVENT_STATES } from '../../src/events/lifecycle';
import { loadConfig, assertProductionSafety } from '../../src/common/config';
import { AuditService } from '../../src/audit/audit.service';

describe('phone normalisation (+251 only for owners)', () => {
  it.each([
    ['0911234567', '+251911234567'], ['911234567', '+251911234567'], ['+251 911 234 567', '+251911234567'],
    ['251711234567', '+251711234567'], ['00251911234567', '+251911234567'], ['0711-234-567', '+251711234567'],
  ])('%s -> %s', (i, o) => expect(normalizeEthiopianPhone(i)).toBe(o));
  it.each(['+254711234567', '0111234567', '12345', '', '+2518123456789', 'abc', '+1 415 555 2671'])('rejects %s', (i) => expect(normalizeEthiopianPhone(i)).toBeNull());
  it('guests may use foreign numbers only when enabled', () => {
    expect(normalizeGuestPhone('+14155552671', false)).toBeNull();
    expect(normalizeGuestPhone('+14155552671', true)).toBe('+14155552671');
    expect(normalizeGuestPhone('0911234567', false)).toBe('+251911234567');
  });
  it('local display', () => expect(displayLocal('+251911234567')).toBe('0911 234 567'));
});

describe('Ethiopian calendar', () => {
  it('Enkutatash 2019 EC is 11 Sep 2026; 2016 EC is 12 Sep 2023', () => {
    expect(gregorianToEthiopian(2026, 9, 11)).toEqual({ year: 2019, month: 1, day: 1 });
    expect(gregorianToEthiopian(2023, 9, 12)).toEqual({ year: 2016, month: 1, day: 1 });
    expect(gregorianToEthiopian(2026, 10, 2)).toEqual({ year: 2019, month: 1, day: 22 });
  });
  it('round-trips over many dates', () => {
    for (let d = 0; d < 4000; d += 7) {
      const g = new Date(Date.UTC(2015, 0, 1) + d * 86400000);
      const e = gregorianToEthiopian(g.getUTCFullYear(), g.getUTCMonth() + 1, g.getUTCDate());
      expect(ethiopianToGregorian(e.year, e.month, e.day)).toEqual({ year: g.getUTCFullYear(), month: g.getUTCMonth() + 1, day: g.getUTCDate() });
    }
  });
  it('Pagume has 6 days in leap years (year % 4 == 3)', () => {
    expect(isEthiopianLeapYear(2015)).toBe(true);
    const g = ethiopianToGregorian(2015, 13, 6);
    expect(gregorianToEthiopian(g.year, g.month, g.day)).toEqual({ year: 2015, month: 13, day: 6 });
  });
});

describe('crypto', () => {
  const cfg = loadConfig({ NODE_ENV: 'test' } as any);
  const c = new CryptoService(cfg);
  it('AES-GCM round trip incl. Ethiopic text, tamper detection', () => {
    const blob = c.encrypt('+251911234567 አበበ');
    expect(c.decrypt(blob)).toBe('+251911234567 አበበ');
    expect(blob).not.toContain('251911');
    const [v, iv, tag, ct] = blob.split('.');
    expect(() => c.decrypt([v, iv, tag, Buffer.from('x').toString('base64url') + ct].join('.'))).toThrow();
  });
  it('blind index is keyed and domain separated', () => {
    expect(c.hmac('x', 'phone')).toBe(c.hmac('x', 'phone'));
    expect(c.hmac('x', 'phone')).not.toBe(c.hmac('x', 'ip'));
    expect(c.hmac('x', 'phone')).not.toBe(sha256Hex('x'));
  });
  it('passcode hashing verifies', async () => {
    const h = await c.hashSecret('Correct Horse 1');
    expect(await c.verifySecret('Correct Horse 1', h)).toBe(true);
    expect(await c.verifySecret('wrong', h)).toBe(false);
  });
  it('signatures', () => {
    const s = c.sign('a'); expect(c.verifySig('a', s)).toBe(true); expect(c.verifySig('b', s)).toBe(false);
  });
  it('join codes use the unambiguous alphabet', () => {
    for (let i = 0; i < 200; i++) expect(randomFromAlphabet(JOIN_CODE_ALPHABET, 8)).toMatch(/^[A-HJKMNP-Z2-9]{8}$/);
  });
});

describe('TOTP (RFC 6238)', () => {
  it('matches the RFC test vector (SHA1, secret "12345678901234567890")', () => {
    const secret = base32Encode(Buffer.from('12345678901234567890'));
    expect(totpAt(secret, Math.floor(59 / 30))).toBe('287082');
    expect(totpAt(secret, Math.floor(1111111109 / 30))).toBe('081804');
  });
  it('accepts +-1 step drift, rejects others', () => {
    const secret = base32Encode(Buffer.from('12345678901234567890'));
    const now = 1_700_000_000_000;
    const step = Math.floor(now / 30000);
    expect(totpVerify(secret, totpAt(secret, step - 1), now)).toBe(step - 1);
    expect(totpVerify(secret, totpAt(secret, step + 5), now)).toBeNull();
    expect(totpVerify(secret, '12345', now)).toBeNull();
  });
});

describe('event lifecycle state model (spec section 7)', () => {
  it('only legal transitions are allowed', () => {
    expect(canTransition('draft', 'live')).toBe(true);
    expect(canTransition('draft', 'read_only')).toBe(false);
    expect(canTransition('live', 'read_only')).toBe(false);     // must pass through closing
    expect(canTransition('closing', 'read_only')).toBe(true);
    expect(canTransition('deleted', 'live')).toBe(false);
    expect(canTransition('deletion_pending', 'deleted')).toBe(true);
    expect(canTransition('archived', 'live')).toBe(false);
  });
  it('actions per state', () => {
    expect(stateAllows('live', 'guest_upload')).toBe(true);
    for (const s of EVENT_STATES.filter((x) => x !== 'live')) expect(stateAllows(s, 'guest_upload')).toBe(false);
    expect(stateAllows('closing', 'upload_continue')).toBe(true);
    expect(stateAllows('read_only', 'guest_view')).toBe(true);
    expect(stateAllows('archived', 'guest_view')).toBe(false);
    expect(stateAllows('suspended', 'guest_view')).toBe(false);
    expect(stateAllows('draft', 'pay')).toBe(true);
    expect(stateAllows('deletion_pending', 'cancel_deletion')).toBe(true);
    expect(allowedActions('deleted')).toEqual([]);
    expect(() => assertAllowed('suspended', 'moderate')).toThrow(/not available/);
  });
  it('clock decides state on activation', () => {
    const base = { upload_opens_at: '2026-10-10T00:00:00Z', upload_closes_at: '2026-10-11T00:00:00Z' };
    expect(stateFromClock(new Date('2026-10-01T00:00:00Z'), base)).toBe('scheduled');
    expect(stateFromClock(new Date('2026-10-10T12:00:00Z'), base)).toBe('live');
    expect(stateFromClock(new Date('2026-10-12T00:00:00Z'), base)).toBe('closing');
  });
});

describe('production safety (data residency + secrets)', () => {
  const good = {
    NODE_ENV: 'production', PUBLIC_API_URL: 'https://api.example.et', PUBLIC_WEB_URL: 'https://example.et',
    JWT_ACCESS_SECRET: 'a'.repeat(48), JWT_GUEST_SECRET: 'b'.repeat(48), URL_SIGNING_SECRET: 'c'.repeat(48), HASH_PEPPER: 'd'.repeat(48), METRICS_TOKEN: 'e'.repeat(48), S3_SECRET_KEY: 'f'.repeat(48),
    DATA_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'), AV_MODE: 'clamd', PAYMENT_PROVIDER: 'chapa', SMS_PROVIDERS: 'primary,fallback',
    DATABASE_URL: 'postgres://u:p@db.internal:5432/x', REDIS_URL: 'redis://redis.internal:6379/0', S3_ENDPOINT: 'https://storage.example.et',
    DATA_RESIDENCY_ALLOWED_HOST_SUFFIXES: '.internal,.et', SMS_HTTP_PRIMARY_URL: 'https://sms.example.et', SMS_HTTP_FALLBACK_URL: 'https://sms2.example.et',
  };
  it('accepts a compliant production config', () => expect(() => loadConfig(good as any)).not.toThrow());
  it('refuses dev secrets, fixed OTP, sandbox payments, eicar AV', () => {
    for (const bad of [{ JWT_ACCESS_SECRET: 'dev_only_x'.padEnd(40, 'x') }, { OTP_FIXED_CODE: '123456' }, { PAYMENT_PROVIDER: 'sandbox' }, { AV_MODE: 'eicar' }, { SMS_PROVIDERS: 'console' }])
      expect(() => loadConfig({ ...good, ...bad } as any)).toThrow(/Unsafe production configuration/);
  });
  it('refuses foreign cloud endpoints (PDPP Art. 22)', () => {
    expect(() => loadConfig({ ...good, S3_ENDPOINT: 'https://s3.eu-west-1.amazonaws.com' } as any)).toThrow(/foreign cloud/);
    expect(() => loadConfig({ ...good, DATABASE_URL: 'postgres://u:p@somewhere.example.com/x' } as any)).toThrow(/DATA_RESIDENCY/);
  });
  it('assertProductionSafety is a no-op outside production', () => expect(() => assertProductionSafety(loadConfig({ NODE_ENV: 'development' } as any))).not.toThrow());
});

describe('audit hash chain', () => {
  it('hash is deterministic and sensitive to every field; jsonb key order does not matter', () => {
    const h = (o: any) => AuditService.computeHash('p', 'id', 't', 'user', 'a', 'x', 'event', 'r', null, o, null);
    expect(h({ a: 1, b: 2 })).toBe(h({ b: 2, a: 1 }));
    expect(h({ a: 1 })).not.toBe(h({ a: 2 }));
    expect(AuditService.computeHash('p1', 'id', 't', 'user', 'a', 'x', 'event', 'r', null, null, null)).not.toBe(AuditService.computeHash('p2', 'id', 't', 'user', 'a', 'x', 'event', 'r', null, null, null));
  });
});
