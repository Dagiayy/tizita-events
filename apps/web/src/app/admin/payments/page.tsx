'use client';
import { useState } from 'react';
import { api, stepUpOk } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { ErrorBox, Tabs, useAction } from '@/components/ui';
import { DataTable, Section, StepUp, useFetch } from '@/components/admin/parts';

export default function Payments() {
  const { t } = useI18n();
  const [tab, setTab] = useState<'orders' | 'callbacks' | 'recon' | 'refunds' | 'invoices'>('orders');
  const path = { orders: '/admin/payments/orders', callbacks: '/admin/payments/callbacks', recon: '/admin/payments/reconciliation', refunds: '/admin/payments/refunds', invoices: '/admin/payments/invoices' }[tab];
  const { data, error, reload } = useFetch<any[]>(path, [tab]);
  const [totp, setTotp] = useState(''); const [ref, setRef] = useState('');
  const run = useAction(async (fn: () => Promise<unknown>) => { await fn(); setTotp(''); reload(); });
  return (
    <>
      <h1>{t('admin.nav.payments')}</h1>
      <Tabs value={tab} onChange={setTab} tabs={[{ id: 'orders', label: t('admin.payments.orders') }, { id: 'callbacks', label: 'Callbacks' }, { id: 'recon', label: 'Reconciliation' }, { id: 'refunds', label: t('admin.payments.refunds') }, { id: 'invoices', label: 'Invoices' }]} />
      <ErrorBox error={error ?? run.error} />
      {tab === 'recon' && <button className="btn" disabled={run.pending} onClick={() => run.run(() => api.post('/admin/payments/reconcile'))}>{t('admin.payments.reconcile')}</button>}
      {tab === 'orders' && <><StepUp value={totp} onChange={setTotp} /><DataTable rows={data} cols={[...['order_ref', 'public_code', 'plan_code', 'amount_etb', 'state', 'provider', 'created_at'].map((k) => ({ key: k, label: k.replace(/_/g, ' ') })), { key: 'x', label: '', render: (r: any) => r.state === 'paid' ? <button className="btn sm danger" disabled={!stepUpOk(totp)} onClick={() => { const reason = window.prompt('Refund reason'); if (reason) run.run(() => api.post(`/admin/payments/orders/${r.id}/refund`, { reason, totp_code: totp })); }}>Refund</button> : null }]} /></>}
      {tab === 'refunds' && <Section title={t('admin.payments.refunds')}><StepUp value={totp} onChange={setTotp} /><label className="field" style={{ maxWidth: 320 }}><span>Provider refund reference</span><input value={ref} onChange={(e) => setRef(e.target.value)} /></label>
        <DataTable rows={data} cols={[...['order_ref', 'amount_etb', 'state', 'provider_refund_ref', 'reason', 'created_at'].map((k) => ({ key: k, label: k.replace(/_/g, ' ') })), { key: 'x', label: '', render: (r: any) => r.state === 'processing' ? <div className="row"><button className="btn sm primary" disabled={ref.length < 3 || !stepUpOk(totp)} onClick={() => run.run(() => api.post(`/admin/payments/refunds/${r.id}/confirm`, { provider_refund_ref: ref, totp_code: totp }))}>Confirm (provider done)</button><button className="btn sm" onClick={() => { const note = window.prompt('Why did it fail?'); if (note) run.run(() => api.post(`/admin/payments/refunds/${r.id}/fail`, { note })); }}>Failed</button></div> : null }]} /></Section>}
      {tab === 'callbacks' && <DataTable rows={data} cols={['provider', 'order_ref', 'signature_valid', 'outcome', 'received_at'].map((k) => ({ key: k, label: k.replace(/_/g, ' ') }))} />}
      {tab === 'recon' && <DataTable rows={data} cols={['run_date', 'provider', 'checked', 'matched', 'mismatched', 'outage'].map((k) => ({ key: k, label: k.replace(/_/g, ' ') }))} />}
      {tab === 'invoices' && <DataTable rows={data} cols={['number', 'amount_etb', 'tax_status', 'tax_amount_etb', 'status', 'issued_at'].map((k) => ({ key: k, label: k.replace(/_/g, ' ') }))} />}
    </>
  );
}
