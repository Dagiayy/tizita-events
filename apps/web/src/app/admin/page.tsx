'use client';
import { useI18n } from '@/lib/i18n';
import { formatBytes } from '@/lib/api';
import { ErrorBox, Spinner } from '@/components/ui';
import { sampleCover } from '@/lib/samples';
import { DataTable, Section, Stat, useFetch } from '@/components/admin/parts';

export default function Dashboard() {
  const { t } = useI18n();
  const { data: d, error } = useFetch<any>('/admin/dashboard');
  if (error) return <ErrorBox error={error} />;
  if (!d) return <Spinner />;
  const q = Object.entries(d.queues).map(([name, c]: any) => ({ id: name, queue: name, ...c }));
  return (
    <>
      <section className="greeting" style={{ ['--img' as string]: `url(${sampleCover('conference')})` }}><h1>{t('admin.nav.dashboard')}</h1></section>
      <div className="stats">
        <Stat v={d.active_events} label={t('admin.dash.activeEvents')} />
        <Stat v={formatBytes(d.storage_bytes)} label={t('admin.dash.storage')} />
        <Stat v={d.failed_uploads_24h} label={t('admin.dash.failed')} tone={d.failed_uploads_24h > 0 ? 'warn' : undefined} />
        <Stat v={d.moderation.escalated + d.moderation.open_reports} label={t('admin.dash.reports')} tone={d.moderation.escalated > 0 ? 'bad' : undefined} />
        <Stat v={d.incidents.open} label={t('admin.dash.incidents')} tone={d.incidents.breach_awaiting_regulator_notice > 0 ? 'bad' : undefined} />
      </div>
      <Section title="Events by state"><div className="row">{Object.entries(d.events_by_state).map(([s, n]) => <span key={s} className="badge">{s}: {String(n)}</span>)}</div></Section>
      <Section title={t('admin.dash.queues')}><DataTable rows={q} cols={['queue', 'waiting', 'active', 'delayed', 'failed'].map((k) => ({ key: k, label: k }))} /></Section>
      <Section title="KPIs (30d)"><div className="stats">{Object.entries(d.kpis).filter(([k]) => k !== 'window_days').map(([k, v]) => <Stat key={k} v={v === null ? '—' : String(v)} label={k.replace(/_/g, ' ')} />)}</div></Section>
      <Section title="Payments (30d)"><DataTable rows={d.payments_30d.map((p: any) => ({ id: p.state, ...p }))} cols={[{ key: 'state', label: 'state' }, { key: 'n', label: '#' }, { key: 'total_etb', label: 'ETB' }]} /></Section>
      <Section title="SMS (7d)"><DataTable rows={d.sms_usage_7d.map((p: any, i: number) => ({ id: i, ...p }))} cols={['day', 'provider', 'total', 'failed'].map((k) => ({ key: k, label: k }))} /></Section>
    </>
  );
}
