'use client';
import { useState } from 'react';
import { api } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { ErrorBox, useAction } from '@/components/ui';
import { DataTable, Section, useFetch } from '@/components/admin/parts';

/** Platform trust & safety: escalated reports, blocked sessions, upload spikes, malware failures. Staff can restrict content without viewing it. */
export default function Moderation() {
  const { t } = useI18n();
  const [status, setStatus] = useState('escalated');
  const { data, error, reload } = useFetch<any[]>(`/admin/moderation/reports?status=${status}`, [status]);
  const { data: sig } = useFetch<any>('/admin/moderation/signals');
  const act = useAction(async (mediaId: string, action: string) => { const reason = window.prompt('Reason (shown in the audit log)'); if (!reason || reason.length < 5) return; await api.post(`/admin/moderation/media/${mediaId}/action`, { action, reason }); reload(); });
  return (
    <>
      <h1>{t('admin.nav.moderation')}</h1>
      <div className="row">{['escalated', 'open', 'actioned', 'dismissed'].map((s) => <button key={s} className={`btn sm ${s === status ? 'primary' : ''}`} onClick={() => setStatus(s)}>{s}</button>)}</div>
      <ErrorBox error={error ?? act.error} />
      <DataTable rows={data} cols={[...['created_at', 'public_code', 'event_name', 'reason', 'severity', 'status'].map((k) => ({ key: k, label: k.replace(/_/g, ' ') })), { key: 'x', label: '', render: (r: any) => <div className="row"><button className="btn sm" onClick={() => act.run(r.media_id, 'hide')}>Hide</button><button className="btn sm danger" onClick={() => act.run(r.media_id, 'delete')}>Delete</button></div> }]} />
      {sig && <>
        <Section title="Blocked sessions"><DataTable rows={sig.blocked_sessions.map((r: any) => ({ id: r.event_id, ...r }))} cols={[{ key: 'event_id', label: 'event' }, { key: 'blocked_sessions', label: '#' }]} /></Section>
        <Section title="Upload spikes (10 min)"><DataTable rows={sig.upload_spikes.map((r: any) => ({ id: r.event_id, ...r }))} cols={[{ key: 'event_id', label: 'event' }, { key: 'uploads_10m', label: 'uploads' }]} /></Section>
        <Section title="Malware failures (7d)"><DataTable rows={sig.malware_failures.map((r: any) => ({ id: r.event_id, ...r }))} cols={[{ key: 'event_id', label: 'event' }, { key: 'n', label: '#' }]} /></Section>
      </>}
    </>
  );
}
