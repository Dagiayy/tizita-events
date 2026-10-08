'use client';
import { useState } from 'react';
import { api, stepUpOk } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { ErrorBox, Field, Modal, useAction } from '@/components/ui';
import { DataTable, Section, StepUp, useFetch } from '@/components/admin/parts';

/** Event administration. Search returns metadata only; content access needs an approved, audited grant (see "Media access"). */
export default function Events() {
  const { t } = useI18n();
  const [q, setQ] = useState({ code: '', owner_phone: '', title: '', city: '', state: '' }); const [applied, setApplied] = useState(''); const [sel, setSel] = useState<string | null>(null);
  const { data, error } = useFetch<{ events: any[] }>(`/admin/events?${applied}`, [applied]);
  const search = (e: React.FormEvent) => { e.preventDefault(); setApplied(new URLSearchParams(Object.entries(q).filter(([, v]) => v) as [string, string][]).toString()); };
  return (
    <>
      <h1>{t('admin.nav.events')}</h1>
      <form className="card grid2" onSubmit={search}>
        <Field label={t('admin.events.code')}><input type="text" value={q.code} onChange={(e) => setQ({ ...q, code: e.target.value })} /></Field>
        <Field label={t('admin.events.ownerPhone')}><input type="tel" value={q.owner_phone} onChange={(e) => setQ({ ...q, owner_phone: e.target.value })} /></Field>
        <Field label={t('admin.events.title')}><input type="text" value={q.title} onChange={(e) => setQ({ ...q, title: e.target.value })} /></Field>
        <Field label={t('common.city')}><input type="text" value={q.city} onChange={(e) => setQ({ ...q, city: e.target.value })} /></Field>
        <Field label={t('common.status')}><select value={q.state} onChange={(e) => setQ({ ...q, state: e.target.value })}><option value="">—</option>{['draft', 'scheduled', 'live', 'closing', 'read_only', 'archived', 'deletion_pending', 'deleted', 'suspended'].map((s) => <option key={s}>{s}</option>)}</select></Field>
        <div style={{ alignSelf: 'end' }}><button className="btn primary">{t('common.search')}</button></div>
      </form>
      <ErrorBox error={error} />
      <DataTable rows={data?.events} onRow={(r) => setSel(r.id)} cols={['public_code', 'name', 'state', 'city', 'owner_phone_last4', 'media_count', 'starts_at', 'legal_hold'].map((k) => ({ key: k, label: k.replace(/_/g, ' ') }))} />
      {sel && <EventPanel id={sel} onClose={() => setSel(null)} />}
    </>
  );
}

function EventPanel({ id, onClose }: { id: string; onClose: () => void }) {
  const { t } = useI18n();
  const { data: e, error, reload } = useFetch<any>(`/admin/events/${id}`);
  const [reason, setReason] = useState(''); const [totp, setTotp] = useState('');
  const act = useAction(async (path: string, extra: Record<string, unknown> = {}) => { await api.post(`/admin/events/${id}/${path}`, { reason, totp_code: totp || undefined, ...extra }); setTotp(''); reload(); });
  const hold = useAction(async (release: boolean) => { if (release) await api.del(`/admin/events/${id}/legal-hold?reason=${encodeURIComponent(reason)}&totp_code=${totp}`); else await api.post(`/admin/events/${id}/legal-hold`, { reason, totp_code: totp }); setTotp(''); reload(); });
  const access = useAction(async () => { await api.post('/admin/media-access', { event_id: id, reason }); window.location.href = '/admin/access'; });
  return (
    <Modal title={e?.name ?? '…'} onClose={onClose}>
      <ErrorBox error={error ?? act.error ?? hold.error ?? access.error} />
      {e && (
        <div className="stack">
          <div className="row"><span className="badge">{e.public_code}</span><span className="badge">{e.state}</span><span className="small muted">{e.city} · …{e.owner.phone_last4}</span></div>
          <div className="small muted">{t('admin.events.mediaHidden')}</div>
          <div className="stats"><div className="stat"><b>{e.usage.media_count}</b><span>media</span></div><div className="stat"><b>{e.open_reports}</b><span>reports</span></div><div className="stat"><b>{e.payments.length}</b><span>payments</span></div></div>
          <Field label={t('common.reason')} hint={t('admin.access.reasonHint')}><input type="text" value={reason} onChange={(ev) => setReason(ev.target.value)} /></Field>
          <StepUp value={totp} onChange={setTotp} />
          <div className="row">
            {e.state !== 'suspended' ? <button className="btn danger" disabled={reason.length < 5 || !stepUpOk(totp)} onClick={() => act.run('suspend')}>{t('admin.events.suspend')}</button> : <button className="btn" disabled={reason.length < 5 || !stepUpOk(totp)} onClick={() => act.run('unsuspend')}>{t('admin.events.unsuspend')}</button>}
            <button className="btn" disabled={reason.length < 5 || e.state !== 'read_only'} onClick={() => act.run('archive')}>{t('admin.events.archive')}</button>
            <button className="btn" disabled={reason.length < 5 || e.state !== 'archived'} onClick={() => act.run('restore')}>{t('admin.events.restore')}</button>
            <button className="btn" disabled={reason.length < 5 || !stepUpOk(totp)} onClick={() => hold.run(!!e.lifecycle.legal_hold)}>{e.lifecycle.legal_hold ? t('admin.events.releaseHold') : t('admin.events.legalHold')}</button>
            <button className="btn" disabled={reason.length < 10} onClick={() => access.run()}>{t('admin.events.requestAccess')}</button>
          </div>
          <Section title="Lifecycle"><pre className="small" style={{ whiteSpace: 'pre-wrap' }}>{JSON.stringify(e.lifecycle, null, 2)}</pre></Section>
          <Section title="Deletion jobs"><DataTable rows={e.deletion_jobs} cols={['status', 'scheduled_at', 'completed_at', 'legal_hold'].map((k) => ({ key: k, label: k }))} /></Section>
        </div>
      )}
    </Modal>
  );
}
