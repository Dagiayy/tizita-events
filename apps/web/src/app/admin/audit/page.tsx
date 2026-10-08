'use client';
import { useState } from 'react';
import { api } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { ErrorBox, useAction } from '@/components/ui';
import { DataTable, useFetch } from '@/components/admin/parts';

export default function Audit() {
  const { t } = useI18n();
  const [f, setF] = useState({ action: '', resource_type: '', event_id: '' }); const [applied, setApplied] = useState('limit=100');
  const { data, error } = useFetch<any[]>(`/admin/audit?${applied}`, [applied]);
  const verify = useAction(async () => api.get<{ checked: number; brokenAtSeq: number | null }>('/admin/audit/verify'));
  const [vr, setVr] = useState<{ checked: number; brokenAtSeq: number | null } | null>(null);
  return (
    <>
      <h1>{t('admin.nav.audit')}</h1>
      <form className="card row" onSubmit={(e) => { e.preventDefault(); setApplied(new URLSearchParams([['limit', '100'], ...Object.entries(f).filter(([, v]) => v)] as [string, string][]).toString()); }}>
        <input placeholder="action prefix, e.g. payment." value={f.action} onChange={(e) => setF({ ...f, action: e.target.value })} style={{ maxWidth: 240 }} />
        <input placeholder="resource type" value={f.resource_type} onChange={(e) => setF({ ...f, resource_type: e.target.value })} style={{ maxWidth: 180 }} />
        <input placeholder="event id" value={f.event_id} onChange={(e) => setF({ ...f, event_id: e.target.value })} style={{ maxWidth: 300 }} />
        <button className="btn primary">{t('common.search')}</button>
        <button type="button" className="btn" onClick={async () => setVr((await verify.run()) ?? null)}>{t('admin.audit.verify')}</button>
      </form>
      {vr && (vr.brokenAtSeq === null ? <div className="alert ok">{t('admin.audit.intact')} ({vr.checked})</div> : <div className="alert error">Chain broken at #{vr.brokenAtSeq}</div>)}
      <ErrorBox error={error ?? verify.error} />
      <DataTable rows={data} cols={['seq', 'created_at', 'actor_type', 'actor_role', 'action', 'resource_type', 'reason', 'ip', 'before_summary', 'after_summary'].map((k) => ({ key: k, label: k.replace(/_/g, ' ') }))} />
    </>
  );
}
