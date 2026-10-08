'use client';
import { Suspense, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { request } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { ErrorBox, Topbar, useAction } from '@/components/ui';

/** Stand-in for the licensed payment gateway checkout page. Only works when the API runs PAYMENT_PROVIDER=sandbox (never in production). */
function Inner() {
  const { t } = useI18n(); const ref = useSearchParams().get('ref') ?? '';
  const [result, setResult] = useState<string | null>(null);
  const pay = useAction(async (outcome: 'success' | 'failed' | 'cancelled') => { const r = await request<{ outcome: string }>('/dev/sandbox/pay', { method: 'POST', json: { tx_ref: ref, outcome } }); setResult(r.outcome); });
  return (
    <main className="narrow stack" style={{ paddingTop: 32 }}>
      <div className="alert warn">SANDBOX PAYMENT GATEWAY — development only. No real money moves.</div>
      <h1>Order {ref}</h1>
      <ErrorBox error={pay.error} />
      {result ? <><div className="alert ok">Result: {result}</div><button className="btn primary" onClick={() => history.back()}>{t('common.back')}</button></> : (
        <div className="stack">
          <button className="btn primary" disabled={pay.pending} onClick={() => pay.run('success')}>Pay (success)</button>
          <button className="btn" disabled={pay.pending} onClick={() => pay.run('failed')}>Fail</button>
          <button className="btn" disabled={pay.pending} onClick={() => pay.run('cancelled')}>Cancel</button>
        </div>
      )}
    </main>
  );
}
export default function Page() { return <><Topbar title="Sandbox gateway" /><Suspense><Inner /></Suspense></>; }
