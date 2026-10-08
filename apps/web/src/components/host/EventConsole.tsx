'use client';
import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { formatDate } from '@/lib/ethiopian';
import { useI18n } from '@/lib/i18n';
import { ErrorBox, Spinner, StateBadge, Tabs } from '@/components/ui';
import { eventCover } from '@/lib/samples';
import { GalleryTab } from './GalleryTab';
import { ExportsTab, FoldersTab, InsightsTab, TeamTab } from './MoreTabs';
import { OverviewTab, PaymentTab, SettingsTab, ShareTab } from './SetupTabs';

export interface EventDto {
  id: string; name: string; type: string; cover_url?: string | null; state: string; role: 'owner' | 'moderator' | 'photographer'; city: string; venue?: string; host_name?: string; starts_at: string; ends_at: string; upload_opens_at: string; upload_closes_at: string; language: 'en' | 'am'; has_cover: boolean;
  settings: Record<string, any>; lifecycle: Record<string, any>; allowed_actions: string[]; media_count: number; storage_bytes: number;
  entitlement: { has_package: boolean; storage_bytes: number; max_media: number; retention_days: number; original_storage: boolean; allow_original_export: boolean; watermark: boolean; photographer_seats: number; max_collaborators: number };
  usage: { used_bytes: number; media_count: number; percent: number; alert_level: number };
}
type Tab = 'overview' | 'share' | 'gallery' | 'folders' | 'team' | 'exports' | 'insights' | 'settings' | 'payment';

export function EventConsole({ id }: { id: string }) {
  const { t, lang } = useI18n();
  const [ev, setEv] = useState<EventDto | null>(null); const [err, setErr] = useState<unknown>(null);
  const [tab, setTab] = useState<Tab>('overview');
  const reload = useCallback(async () => { try { setEv(await api.get<EventDto>(`/events/${id}`)); setErr(null); } catch (e) { setErr(e); } }, [id]);
  useEffect(() => { void reload(); const h = new URLSearchParams(window.location.search); if (h.get('payment')) setTab('payment'); }, [reload]);
  if (err) return <main className="wrap" style={{ paddingTop: 20 }}><ErrorBox error={err} /></main>;
  if (!ev) return <Spinner />;
  const owner = ev.role === 'owner'; const photographer = ev.role === 'photographer';
  const tabs: { id: Tab; label: string }[] = [
    { id: 'overview', label: t('host.tab.overview') },
    ...(!photographer ? [{ id: 'share' as Tab, label: t('host.tab.share') }] : []),
    { id: 'gallery', label: t('host.tab.gallery') }, { id: 'folders', label: t('host.tab.folders') },
    ...(owner ? [{ id: 'team' as Tab, label: t('host.tab.team') }, { id: 'exports' as Tab, label: t('host.tab.exports') }] : []),
    ...(!photographer ? [{ id: 'insights' as Tab, label: t('host.tab.insights') }] : []),
    ...(owner ? [{ id: 'settings' as Tab, label: t('host.tab.settings') }, { id: 'payment' as Tab, label: t('host.tab.payment') }] : []),
  ];
  const d = formatDate(ev.starts_at, lang, { time: true });
  const hue = [...ev.name].reduce((n, c) => (n * 31 + c.charCodeAt(0)) % 360, 7);
  return (
    <main className="wrap stack console" style={{ paddingTop: 12, paddingBottom: 48 }}>
      <a href="/host" className="back">← {t('host.events.title')}</a>
      <section className="banner" style={{ ['--g' as string]: `linear-gradient(145deg, hsl(${hue} 68% 40%), hsl(${(hue + 40) % 360} 62% 22%))`, ['--img' as string]: `url(${eventCover(ev)})` }}>
        <div className="in">
          <StateBadge state={ev.state} label={t(`host.state.${ev.state}`)} />
          <div>
            <h1>{ev.name}</h1>
            <p>{ev.city}{ev.venue ? ` · ${ev.venue}` : ''}</p>
            <p>{d.gregorian} · {d.ethiopian}</p>
          </div>
        </div>
      </section>
      {ev.state === 'suspended' && <div className="alert error">{t('host.suspended.notice')}</div>}
      <Tabs tabs={tabs} value={tab} onChange={setTab} />
      {tab === 'overview' && <OverviewTab ev={ev} reload={reload} goto={setTab} />}
      {tab === 'share' && <ShareTab ev={ev} reload={reload} />}
      {tab === 'gallery' && <GalleryTab ev={ev} />}
      {tab === 'folders' && <FoldersTab ev={ev} />}
      {tab === 'team' && <TeamTab ev={ev} />}
      {tab === 'exports' && <ExportsTab ev={ev} />}
      {tab === 'insights' && <InsightsTab ev={ev} />}
      {tab === 'settings' && <SettingsTab ev={ev} reload={reload} />}
      {tab === 'payment' && <PaymentTab ev={ev} reload={reload} />}
    </main>
  );
}
