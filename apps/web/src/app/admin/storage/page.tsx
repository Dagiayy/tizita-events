'use client';
import { api, formatBytes } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { ErrorBox, Spinner, useAction } from '@/components/ui';
import { DataTable, Section, Stat, useFetch } from '@/components/admin/parts';

export default function Storage() {
  const { t } = useI18n();
  const { data: d, error, reload } = useFetch<any>('/admin/storage');
  const scan = useAction(async (remove: boolean) => { await api.post('/admin/storage/orphan-scan', { remove }); reload(); });
  if (error) return <ErrorBox error={error} />;
  if (!d) return <Spinner />;
  return (
    <>
      <h1>{t('admin.nav.storage')}</h1>
      <div className="stats"><Stat v={d.totals.media_rows} label="media rows" /><Stat v={d.totals.derivative_objects} label="derivative objects" /><Stat v={formatBytes(d.totals.bytes)} label="stored" /></div>
      <ErrorBox error={scan.error} />
      <Section title="By upload state"><div className="row">{d.by_state.map((s: any) => <span key={s.upload_state} className="badge">{s.upload_state}: {s.n}</span>)}</div></Section>
      <Section title="Failed processing (7d)"><DataTable rows={d.failed_processing_7d.map((r: any, i: number) => ({ id: i, ...r }))} cols={[{ key: 'failure_code', label: 'reason' }, { key: 'n', label: '#' }]} /></Section>
      <Section title="Orphan scans"><div className="row"><button className="btn" disabled={scan.pending} onClick={() => scan.run(false)}>Scan</button><button className="btn danger" disabled={scan.pending} onClick={() => window.confirm('Delete orphaned objects?') && scan.run(true)}>Scan + remove</button></div>
        <DataTable rows={d.scans} cols={['started_at', 'objects_checked', 'orphans_found', 'orphans_removed'].map((k) => ({ key: k, label: k.replace(/_/g, ' ') }))} /></Section>
      <Section title="Backups"><DataTable rows={d.backups} cols={['kind', 'status', 'location_label', 'bytes', 'encrypted', 'started_at', 'verified_at', 'expires_at'].map((k) => ({ key: k, label: k.replace(/_/g, ' ') }))} /></Section>
      <Section title="Largest events"><DataTable rows={d.top_events.map((r: any) => ({ id: r.public_code, ...r, storage: formatBytes(r.storage_bytes) }))} cols={['public_code', 'name', 'state', 'media_count', 'storage', 'est_monthly_cost_etb'].map((k) => ({ key: k, label: k.replace(/_/g, ' ') }))} /></Section>
    </>
  );
}
