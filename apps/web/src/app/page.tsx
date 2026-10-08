'use client';
import { LangSwitch, useI18n } from '@/lib/i18n';

/** Splash: dusk festival scene drawn in CSS (no external images - works offline and keeps data in Ethiopia). */
export default function Home() {
  const { t } = useI18n();
  return (
    <main className="landing">
      <div className="top"><LangSwitch /></div>
      <div className="copy">
        <span className="logo-mark" aria-hidden />
        <p className="wordmark">{t('app.name')}</p>
        <p className="sub">Capture · Share · Relive</p>
        <h1>{t('app.tagline')}</h1>
        <div className="cta">
          <a className="btn primary big block" href="/join">{t('guest.joinByCode.title')}</a>
          <a className="btn big block" href="/host">{t('host.title')}</a>
        </div>
        <p className="foot"><a href="/privacy">{t('common.privacy')}</a> · {t('common.poweredBy')}</p>
      </div>
    </main>
  );
}
