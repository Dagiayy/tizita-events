'use client';
import { useState } from 'react';
import { api, formatBytes, stepUpOk } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { ErrorBox, Tabs, useAction } from '@/components/ui';
import { DataTable, StepUp, useFetch } from '@/components/admin/parts';

/** Organizations, hosts (users), and support history. Phone numbers are always masked. */
export default function Orgs() {
  const { t } = useI18n();
  const [tab, setTab] = useState<'orgs' | 'users' | 'support'>('orgs'); const [phone, setPhone] = useState(''); const [totp, setTotp] = useState('');
  const path = tab === 'orgs' ? '/admin/organizations' : tab === 'users' ? `/admin/users${phone ? `?phone=${encodeURIComponent(phone)}` : ''}` : '/admin/support/tickets';
  const { data, error, reload } = useFetch<any[]>(path, [tab, phone]);
  const act = useAction(async (fn: () => Promise<unknown>) => { await fn(); setTotp(''); reload(); });
  return (
    <>
      <h1>{t('admin.nav.orgs')}</h1>
      <Tabs value={tab} onChange={setTab} tabs={[{ id: 'orgs', label: t('admin.nav.orgs') }, { id: 'users', label: 'Hosts' }, { id: 'support', label: t('admin.nav.support') }]} />
      <ErrorBox error={error ?? act.error} />
      {tab === 'orgs' && <DataTable rows={data} cols={[{ key: 'legal_name', label: 'name' }, { key: 'verification_state', label: 'verification' }, { key: 'users', label: 'users' }, { key: 'events', label: 'events' }, { key: 'storage_bytes', label: 'storage', render: (r: any) => formatBytes(Number(r.storage_bytes)) }, { key: 'invoices', label: 'invoices' },
        { key: 'x', label: '', render: (r: any) => r.verification_state !== 'verified' ? <button className="btn sm" onClick={() => { const reason = window.prompt('Verification basis'); if (reason) act.run(() => api.patch(`/admin/organizations/${r.id}/verification`, { state: 'verified', reason })); }}>Verify</button> : null }]} />}
      {tab === 'users' && <><div className="row"><input type="tel" placeholder="phone" value={phone} onChange={(e) => setPhone(e.target.value)} style={{ maxWidth: 240 }} /><StepUp value={totp} onChange={setTotp} /></div>
        <DataTable rows={data} cols={[{ key: 'phone_last4', label: 'phone', render: (r: any) => `••• ${r.phone_last4}` }, { key: 'status', label: 'status' }, { key: 'platform_role', label: 'role' }, { key: 'events', label: 'events' }, { key: 'tickets', label: 'tickets' }, { key: 'last_login_at', label: 'last login' },
          { key: 'x', label: '', render: (r: any) => r.platform_role === 'none' ? <button className="btn sm" disabled={!stepUpOk(totp)} onClick={() => { const reason = window.prompt('Reason'); if (reason) act.run(() => api.post(`/admin/users/${r.id}/status`, { status: r.status === 'active' ? 'suspended' : 'active', reason, totp_code: totp })); }}>{r.status === 'active' ? 'Suspend' : 'Reinstate'}</button> : null }]} /></>}
      {tab === 'support' && <DataTable rows={data} cols={['ref', 'category', 'subject', 'status', 'phone_last4', 'created_at'].map((k) => ({ key: k, label: k.replace(/_/g, ' ') }))} onRow={(r) => { const status = window.prompt('Status (open/pending/resolved/closed)', r.status); if (status) act.run(() => api.patch(`/admin/support/tickets/${r.id}`, { status, assign_to_me: true })); }} />}
    </>
  );
}
