'use client';
import { useState } from 'react';
import { api, formatBytes, stepUpOk } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { ErrorBox, Field, Modal, useAction } from '@/components/ui';
import { DataTable, Section, StepUp, useFetch } from '@/components/admin/parts';

/** Platform configuration (upload limits, MIME types, maintenance mode, retention defaults) and package catalogue in ETB. Changes need 2FA + a reason and are audited. */
export default function Config() {
  const { t } = useI18n();
  const settings = useFetch<any[]>('/admin/settings'); const plans = useFetch<any[]>('/admin/plans');
  const [edit, setEdit] = useState<{ kind: 'setting' | 'plan'; row: any } | null>(null);
  return (
    <>
      <h1>{t('admin.nav.config')}</h1>
      <Section title={t('admin.config.settings')} error={settings.error}>
        <DataTable rows={settings.data?.map((s) => ({ ...s, id: s.key }))} onRow={(r) => setEdit({ kind: 'setting', row: r })} cols={[{ key: 'key', label: 'key' }, { key: 'value', label: 'value', render: (r: any) => <code>{JSON.stringify(r.value)}</code> }, { key: 'description', label: 'description' }]} />
      </Section>
      <Section title={t('admin.config.plans')} error={plans.error}>
        <DataTable rows={plans.data} onRow={(r) => setEdit({ kind: 'plan', row: r })} cols={[{ key: 'code', label: 'code' }, { key: 'kind', label: 'kind' }, { key: 'price_etb', label: 'ETB' }, { key: 'storage_bytes', label: 'storage', render: (r: any) => formatBytes(Number(r.storage_bytes)) }, { key: 'max_media', label: 'max media' }, { key: 'retention_days', label: 'retention d' }, { key: 'original_storage', label: 'originals' }, { key: 'active', label: 'active' }]} />
      </Section>
      {edit && <Editor edit={edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); settings.reload(); plans.reload(); }} />}
    </>
  );
}

function Editor({ edit, onClose, onSaved }: { edit: { kind: 'setting' | 'plan'; row: any }; onClose: () => void; onSaved: () => void }) {
  const { t } = useI18n();
  const [val, setVal] = useState(edit.kind === 'setting' ? JSON.stringify(edit.row.value) : String(edit.row.price_etb)); const [reason, setReason] = useState(''); const [totp, setTotp] = useState('');
  const save = useAction(async () => {
    if (edit.kind === 'setting') await api.put(`/admin/settings/${edit.row.key}`, { value: JSON.parse(val), reason, totp_code: totp });
    else await api.patch(`/admin/plans/${edit.row.code}`, { price_etb: Number(val), totp_code: totp });
    onSaved();
  });
  return (
    <Modal title={edit.kind === 'setting' ? edit.row.key : `${edit.row.code} — price (ETB)`} onClose={onClose}>
      <form className="stack" onSubmit={(e) => { e.preventDefault(); void save.run(); }}>
        <Field label="Value"><input value={val} onChange={(e) => setVal(e.target.value)} /></Field>
        {edit.kind === 'setting' && <Field label={t('common.reason')}><input value={reason} onChange={(e) => setReason(e.target.value)} /></Field>}
        <StepUp value={totp} onChange={setTotp} />
        <ErrorBox error={save.error} />
        <button className="btn primary" disabled={!stepUpOk(totp) || (edit.kind === 'setting' && reason.length < 5) || save.pending}>{t('common.save')}</button>
      </form>
    </Modal>
  );
}
