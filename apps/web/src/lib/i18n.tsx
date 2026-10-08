'use client';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import en from '../locales/en.json';
import am from '../locales/am.json';

export type Lang = 'en' | 'am';
const DICTS: Record<Lang, Record<string, string>> = { en, am };
const KEY = 'ep.lang';

/** Looks up a key and interpolates {vars}. Falls back to English, then to the key itself (visible in QA, never silent). */
export function translate(lang: Lang, key: string, vars?: Record<string, string | number>): string {
  const raw = DICTS[lang][key] ?? DICTS.en[key] ?? key;
  return vars ? raw.replace(/\{(\w+)\}/g, (_m, k) => String(vars[k] ?? '')) : raw;
}

interface Ctx { lang: Lang; setLang: (l: Lang) => void; t: (key: string, vars?: Record<string, string | number>) => string }
const I18nContext = createContext<Ctx>({ lang: 'en', setLang: () => undefined, t: (k) => k });

export function I18nProvider({ children, initial }: { children: ReactNode; initial?: Lang }) {
  const [lang, setLangState] = useState<Lang>(initial ?? 'en');
  useEffect(() => {
    try {
      const saved = localStorage.getItem(KEY) as Lang | null;
      const guess: Lang = saved ?? (navigator.language?.toLowerCase().startsWith('am') ? 'am' : 'en');
      if (guess !== lang && (!initial || saved)) setLangState(guess);
    } catch { /* storage unavailable (private mode) - keep default */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => { document.documentElement.lang = lang === 'am' ? 'am' : 'en'; }, [lang]);
  const setLang = useCallback((l: Lang) => { setLangState(l); try { localStorage.setItem(KEY, l); } catch { /* ignore */ } }, []);
  const t = useCallback((key: string, vars?: Record<string, string | number>) => translate(lang, key, vars), [lang]);
  const value = useMemo(() => ({ lang, setLang, t }), [lang, setLang, t]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export const useI18n = () => useContext(I18nContext);

export function LangSwitch() {
  const { lang, setLang, t } = useI18n();
  return (
    <div className="lang-switch" role="group" aria-label={t('common.language')}>
      <button type="button" className={lang === 'en' ? 'on' : ''} onClick={() => setLang('en')} aria-pressed={lang === 'en'}>EN</button>
      <button type="button" className={lang === 'am' ? 'on' : ''} onClick={() => setLang('am')} aria-pressed={lang === 'am'} lang="am">አማ</button>
    </div>
  );
}

/** Maps an API error code to a localized, user-friendly message. */
export function errorMessage(t: Ctx['t'], code: string | undefined, fallbackKey = 'err.generic'): string {
  if (!code) return t(fallbackKey);
  const k = `err.${code}`;
  const msg = t(k);
  return msg === k ? t(fallbackKey) : msg;
}
