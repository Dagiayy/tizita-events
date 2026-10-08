'use client';
import { useState } from 'react';
import { api, stepUpOk } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { ErrorBox, Field, Modal, StateBadge, Tabs, useAction } from '@/components/ui';
import { DataTable, StepUp, useFetch } from '@/components/admin/parts';

type Tab = 'rights' | 'jobs' | 'incidents' | 'vendors' | 'consents';

/** Compliance: rights requests, deletion jobs (with evidence), breach incidents with the 72 h clock, vendor register, consent records. */
export default function Compliance() {
  const { t } = useI18n();
  const [tab, setTab] = useState<Tab>('rights'); const [totp, setTotp] = useState('');
  const path = { rights: '/admin/compliance/rights-requests', jobs: '/admin/compliance/deletion-jobs', incidents: '/admin/compliance/incidents', vendors: '/admin/compliance/vendors', consents: '/admin/compliance/consents' }[tab];
  const { data, error, reload } = useFetch<any[]>(path, [tab]);
  const [modal, setModal] = useState<'incident' | null>(null);
  const act = useAction(async (fn: () => Promise<unknown>) => { await fn(); setTotp(''); reload(); });
  return (
    <>
      <h1>{t('admin.nav.compliance')}</h1>
      <p className="alert warn small">Legal interpretation (retention periods, response deadlines, controller/processor roles, VAT) is configurable and flagged for Ethiopian counsel - see docs/LEGAL_FLAGS.md.</p>
      <Tabs value={tab} onChange={setTab} tabs={[{ id: 'rights', label: t('admin.compliance.rights') }, { id: 'jobs', label: t('admin.compliance.jobs') }, { id: 'incidents', label: t('admin.compliance.incidents') }, { id: 'vendors', label: t('admin.compliance.vendors') }, { id: 'consents', label: t('admin.compliance.consents') }]} />
      <ErrorBox error={error ?? act.error} />
      {tab === 'rights' && <DataTable rows={data} cols={[...['ref', 'type', 'requester_kind', 'state', 'due_at', 'overdue'].map((k) => ({ key: k, label: k.replace(/_/g, ' ') })), { key: 'x', label: '', render: (r: any) => <div className="row">{['received'].includes(r.state) && <button className="btn sm" onClick={() => act.run(() => api.post(`/admin/compliance/rights-requests/${r.id}/advance`, { to: 'identity_verification' }))}>Verify identity</button>}{['received', 'identity_verification'].includes(r.state) && <button className="btn sm" onClick={() => act.run(() => api.post(`/admin/compliance/rights-requests/${r.id}/advance`, { to: 'in_progress' }))}>Start</button>}{r.state === 'in_progress' && <><button className="btn sm primary" onClick={() => { const note = window.prompt('Completion note / evidence'); if (note) act.run(() => api.post(`/admin/compliance/rights-requests/${r.id}/advance`, { to: 'completed', note })); }}>Complete</button><button className="btn sm" onClick={() => { const note = window.prompt('Reason for rejection'); if (note) act.run(() => api.post(`/admin/compliance/rights-requests/${r.id}/advance`, { to: 'rejected', note })); }}>Reject</button></>}</div> }]} />}
      {tab === 'jobs' && <><StepUp value={totp} onChange={setTotp} /><DataTable rows={data} cols={[...['resource_type', 'trigger', 'status', 'scheduled_at', 'completed_at', 'legal_hold', 'backup_purge_by', 'evidence'].map((k) => ({ key: k, label: k.replace(/_/g, ' ') })), { key: 'x', label: '', render: (r: any) => ['pending', 'held', 'failed'].includes(r.status) ? <button className="btn sm danger" disabled={!stepUpOk(totp)} onClick={() => act.run(() => api.post(`/admin/compliance/deletion-jobs/${r.id}/run`, { totp_code: totp }))}>Run now</button> : null }]} /></>}
      {tab === 'incidents' && <><button className="btn primary" onClick={() => setModal('incident')}>+ Incident</button><DataTable rows={data} cols={[{ key: 'ref', label: 'ref' }, { key: 'kind', label: 'kind' }, { key: 'severity', label: 'severity' }, { key: 'state', label: 'state' }, { key: 'discovered_at', label: t('admin.compliance.discovered') }, { key: 'regulator_hours_remaining', label: t('admin.compliance.regulatorClock'), render: (r: any) => r.regulator_notify_due_at ? (r.regulator_notified_at ? <span className="badge ok">notified</span> : <span className={`badge ${r.regulator_overdue ? 'bad' : 'warn'}`}>{r.regulator_overdue ? 'OVERDUE' : `${r.regulator_hours_remaining} h left`}</span>) : '—' }, { key: 'x', label: '', render: (r: any) => !r.regulator_notified_at && r.regulator_notify_due_at ? <button className="btn sm" onClick={() => act.run(() => api.patch(`/admin/compliance/incidents/${r.id}`, { regulator_notified_at: new Date().toISOString(), state: 'notified', entry: 'Regulator notified' }))}>Mark notified</button> : null }]} /></>}
      {tab === 'vendors' && <DataTable rows={data} cols={['name', 'purpose', 'data_location', 'outside_ethiopia', 'dpa_signed', 'status'].map((k) => ({ key: k, label: k.replace(/_/g, ' ') }))} />}
      {tab === 'consents' && <DataTable rows={data} cols={['created_at', 'subject_type', 'purpose', 'policy_version', 'action', 'withdrawn_at'].map((k) => ({ key: k, label: k.replace(/_/g, ' ') }))} />}
      {modal === 'incident' && <IncidentForm onClose={() => setModal(null)} onSaved={() => { setModal(null); reload(); }} />}
    </>
  );
}

function IncidentForm({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const { t } = useI18n();
  const [f, setF] = useState({ kind: 'personal_data_breach', severity: 'high', title: '', description: '', discovered_at: new Date().toISOString().slice(0, 16), data_categories: '' });
  const save = useAction(async () => { await api.post('/admin/compliance/incidents', { ...f, discovered_at: new Date(f.discovered_at).toISOString(), data_categories: f.data_categories ? f.data_categories.split(',').map((s) => s.trim()) : undefined }); onSaved(); });
  return (
    <Modal title="Incident" onClose={onClose}>
      <form className="stack" onSubmit={(e) => { e.preventDefault(); void save.run(); }}>
        <Field label="Kind"><select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>{['security', 'personal_data_breach', 'abuse', 'operational', 'criminal_content'].map((k) => <option key={k}>{k}</option>)}</select></Field>
        <Field label="Severity"><select value={f.severity} onChange={(e) => setF({ ...f, severity: e.target.value })}>{['low', 'medium', 'high', 'critical'].map((k) => <option key={k}>{k}</option>)}</select></Field>
        <Field label="Title"><input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></Field>
        <Field label={t('admin.compliance.discovered')} hint="Starts the 72-hour clock for personal data breaches. Do not use the ticket creation time."><input type="datetime-local" value={f.discovered_at} onChange={(e) => setF({ ...f, discovered_at: e.target.value })} /></Field>
        <Field label="Data categories (comma separated)"><input value={f.data_categories} onChange={(e) => setF({ ...f, data_categories: e.target.value })} /></Field>
        <Field label="Description"><textarea value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
        <ErrorBox error={save.error} />
        <button className="btn primary" disabled={f.title.length < 3 || save.pending}>{t('common.save')}</button>
      </form>
    </Modal>
  );
}
void StateBadge;
