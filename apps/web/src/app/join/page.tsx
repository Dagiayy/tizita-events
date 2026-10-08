'use client';
import { useState } from 'react';
import { LangSwitch, useI18n } from '@/lib/i18n';
import { Field, Topbar } from '@/components/ui';

/** Manual join with the short code, for guests who cannot scan the QR (D46). */
export default function JoinByCode() {
  const { t } = useI18n();
  const [code, setCode] = useState('');
  const go = () => { const m = /\/j\/([A-Za-z0-9_-]+)/.exec(code); window.location.href = `/j/${encodeURIComponent((m ? m[1] : code).trim())}`; };
  return (
    <div className="photo-page" style={{ ['--img' as string]: 'url(/samples/other.jpg)' }}>
      <Topbar title={t('app.name')} right={<LangSwitch />} />
      <main className="narrow stack" style={{ paddingTop: 32 }}>
        <h1>{t('guest.joinByCode.title')}</h1>
        <form className="card stack" onSubmit={(e) => { e.preventDefault(); go(); }}>
          <Field label={t('guest.code.label')} hint={t('guest.joinByCode.hint')}>
            <input type="text" autoCapitalize="characters" autoComplete="off" value={code} onChange={(e) => setCode(e.target.value.trim())} maxLength={120} />
          </Field>
          <button className="btn primary big" disabled={code.length < 6}>{t('guest.joinByCode.go')}</button>
        </form>
      </main>
    </div>
  );
}
