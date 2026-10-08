/**
 * Phone normalisation. Event owners/staff must use Ethiopian mobile numbers in E.164 (+251 9X/7X XXXXXXX).
 * Ethio telecom ranges start 9x, Safaricom Ethiopia 7x - we accept both and never assume one operator.
 */
const ET_E164 = /^\+251[79]\d{8}$/;
const ANY_E164 = /^\+[1-9]\d{7,14}$/;

export function normalizeEthiopianPhone(input: string): string | null {
  let s = (input ?? '').replace(/[\s\-().]/g, '');
  if (s.startsWith('00')) s = '+' + s.slice(2);
  if (/^251[79]\d{8}$/.test(s)) s = '+' + s;
  else if (/^0[79]\d{8}$/.test(s)) s = '+251' + s.slice(1);
  else if (/^[79]\d{8}$/.test(s)) s = '+251' + s;
  return ET_E164.test(s) ? s : null;
}

export function normalizeGuestPhone(input: string, allowForeign: boolean): string | null {
  const et = normalizeEthiopianPhone(input);
  if (et) return et;
  if (!allowForeign) return null;
  let s = (input ?? '').replace(/[\s\-().]/g, '');
  if (s.startsWith('00')) s = '+' + s.slice(2);
  return ANY_E164.test(s) ? s : null;
}

/** User-friendly local display, e.g. +251911234567 -> 0911 234 567. */
export function displayLocal(e164: string): string {
  const m = /^\+251([79]\d{2})(\d{3})(\d{3})$/.exec(e164);
  return m ? `0${m[1]} ${m[2]} ${m[3]}` : e164;
}
export const maskPhone = (last4: string): string => `+251 *** *** ${last4}`;
