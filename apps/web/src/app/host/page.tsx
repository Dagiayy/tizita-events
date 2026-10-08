'use client';
import { useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/api';
import { formatDate } from '@/lib/ethiopian';
import { useI18n } from '@/lib/i18n';
import { ErrorBox, Spinner, StateBadge } from '@/components/ui';
import { eventCover } from '@/lib/samples';

interface Ev { id: string; name: string; state: string; city: string; starts_at: string; role: string; media_count: number; type?: string; cover_url?: string | null }

export default function HostHome() {
  const { t, lang } = useI18n();
  const [events, setEvents] = useState<Ev[] | null>(null); const [err, setErr] = useState<unknown>(null);
  const [q, setQ] = useState(''); const [f, setF] = useState<'all' | 'live' | 'draft' | 'done'>('all');
  useEffect(() => { api.get<{ events: Ev[] }>('/events').then((r) => setEvents(r.events)).catch(setErr); }, []);
  const shown = useMemo(() => (events ?? []).filter((e) => (!q || e.name.toLowerCase().includes(q.toLowerCase()) || e.city.toLowerCase().includes(q.toLowerCase())) && (f === 'all' || (f === 'live' ? ['live', 'closing', 'scheduled'].includes(e.state) : f === 'draft' ? e.state === 'draft' : !['live', 'closing', 'scheduled', 'draft'].includes(e.state)))), [events, q, f]);
  return (
    <main className="wrap stack" style={{ paddingTop: 20, paddingBottom: 40 }}>
      <div className="page-head"><h1>{t('host.events.title')}</h1><a className="btn primary" href="/host/new">+ {t('host.events.new')}</a></div>
      <div className="searchbar"><span aria-hidden>⌕</span><input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('host.events.search')} aria-label={t('host.events.search')} /></div>
      <div className="gtabs" role="group">{(['all', 'live', 'draft', 'done'] as const).map((k) => <button key={k} className={`chip ${f === k ? 'on' : ''}`} aria-pressed={f === k} onClick={() => setF(k)}>{t(`host.events.f.${k}`)}</button>)}</div>
      <ErrorBox error={err} />
      {!events && !err && <Spinner />}
      {events && events.length === 0 && <div className="card center muted">{t('host.events.empty')}</div>}
      <div className="evwall">
        {shown.map((e, i) => {
          const d = formatDate(e.starts_at, lang);
          const hue = [...e.name].reduce((n, c) => (n * 31 + c.charCodeAt(0)) % 360, 7);
          return (
            <a key={e.id} href={`/host/events/${e.id}`} className="evcard" style={{ ['--g' as string]: `linear-gradient(145deg, hsl(${hue} 68% 40%), hsl(${(hue + 40) % 360} 62% 22%))`, ['--h' as string]: `${[200, 240, 180, 260][i % 4]}px`, ['--img' as string]: `url(${eventCover(e)})` }}>
              <div className="in">
                <StateBadge state={e.state} label={t(`host.state.${e.state}`)} />
                <div>
                  <strong>{e.name}</strong>
                  <div className="meta">{e.city} · {lang === 'am' ? d.ethiopian : d.gregorian}</div>
                  <div className="meta">{t('host.events.role')}: {t(`host.team.${e.role}`)} · {e.media_count} 📷</div>
                </div>
              </div>
            </a>
          );
        })}
      </div>
    </main>
  );
}
