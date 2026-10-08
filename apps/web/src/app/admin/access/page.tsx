'use client';
import { useState } from 'react';
import { api, stepUpOk } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { ErrorBox, Modal, useAction } from '@/components/ui';
import { DataTable, StepUp, useFetch } from '@/components/admin/parts';

/** Elevated media access: reasoned request -> different super admin approves with 2FA -> time-boxed, audited viewing. */
export default function Access() {
  const { t } = useI18n();
  const { data, error, reload } = useFetch<any[]>('/admin/media-access');
  const [totp, setTotp] = useState(''); const [view, setView] = useState<any | null>(null);
  const act = useAction(async (id: string, what: 'approve' | 'deny' | 'revoke') => { await api.post(`/admin/media-access/${id}/${what}`, what === 'approve' ? { totp_code: totp } : {}); setTotp(''); reload(); });
  const open = useAction(async (id: string) => setView(await api.get(`/admin/media-access/${id}/media`)));
  return (
    <>
      <h1>{t('admin.nav.access')}</h1>
      <p className="muted small">{t('admin.events.mediaHidden')}</p>
      <StepUp value={totp} onChange={setTotp} />
      <ErrorBox error={error ?? act.error ?? open.error} />
      <DataTable rows={data} cols={[
        { key: 'created_at', label: 'created' }, { key: 'reason', label: 'reason' }, { key: 'state', label: 'state' }, { key: 'expires_at', label: 'expires' },
        { key: 'x', label: '', render: (r: any) => <div className="row">
          {r.state === 'requested' && <><button className="btn sm primary" disabled={!stepUpOk(totp)} onClick={() => act.run(r.id, 'approve')}>{t('admin.access.approve')}</button><button className="btn sm" onClick={() => act.run(r.id, 'deny')}>{t('admin.access.deny')}</button></>}
          {r.state === 'approved' && <><button className="btn sm primary" onClick={() => open.run(r.id)}>{t('admin.access.open')}</button><button className="btn sm danger" onClick={() => act.run(r.id, 'revoke')}>{t('admin.access.revoke')}</button></>}
        </div> },
      ]} />
      {view && <Modal title={t('admin.access.open')} onClose={() => setView(null)}><div className="masonry">{view.items.map((i: any) => <div key={i.id} className="tile"><img src={i.urls.viewer} alt="" loading="lazy" /></div>)}</div><p className="small muted">Every view is written to the audit log. Expires {new Date(view.grant_expires_at).toLocaleTimeString()}.</p></Modal>}
    </>
  );
}
