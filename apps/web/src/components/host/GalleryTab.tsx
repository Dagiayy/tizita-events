'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { API_BASE, ApiError, api, request } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { HttpFailure, UploadEngine, createIndexedDbStore, prepareImage, type QueueItem, type UploadApi } from '@/lib/upload-queue';
import { ErrorBox, Modal, Spinner, StateBadge, useAction, useToast } from '@/components/ui';
import type { EventDto } from './EventConsole';

interface Item { id: string; upload_state: string; moderation_state: string; is_highlight: boolean; width: number; height: number; created_at: string; folder_id?: string | null; caption?: string | null; failure_code?: string | null; near_duplicate: boolean; open_reports: number; uploader: string; uploader_session_id?: string; sender?: { key: string; name: string | null }; urls: { thumb: string; gallery: string; viewer: string } | null }
const FILTERS = ['newest', 'all', 'approved', 'pending', 'rejected', 'flagged', 'hidden', 'highlights'] as const;

/** Gallery management + moderation: filters, folders, bulk approve/reject, per-item actions, live updates, member uploads. */
export function GalleryTab({ ev }: { ev: EventDto }) {
  const { t } = useI18n(); const toast = useToast();
  const canModerate = ev.role !== 'photographer';
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>(canModerate ? 'pending' : 'newest'); const [folder, setFolder] = useState(''); const [sender, setSender] = useState('');
  const [senders, setSenders] = useState<{ key: string; name: string | null; count: number }[]>([]);
  const [folders, setFolders] = useState<{ id: string; name: string }[]>([]);
  const [items, setItems] = useState<Item[]>([]); const [cursor, setCursor] = useState<string | null>(null); const [loading, setLoading] = useState(true); const [error, setError] = useState<unknown>(null);
  const [sel, setSel] = useState<Set<string>>(new Set()); const [open, setOpen] = useState<Item | null>(null); const [logs, setLogs] = useState<any[] | null>(null);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async (cur: string | null, replace: boolean) => {
    setLoading(true);
    try {
      const r = await api.get<{ items: Item[]; next_cursor: string | null }>(`/events/${ev.id}/media?filter=${filter}&limit=40${folder ? `&folder_id=${folder}` : ''}${sender ? `&sender=${sender}` : ''}${cur ? `&cursor=${cur}` : ''}`);
      setItems((p) => (replace ? r.items : [...p, ...r.items])); setCursor(r.next_cursor); setError(null);
    } catch (e) { setError(e); } finally { setLoading(false); }
  }, [ev.id, filter, folder, sender]);
  useEffect(() => { setSel(new Set()); void load(null, true); }, [load]);
  useEffect(() => { api.get<{ senders: { key: string; name: string | null; count: number }[] }>(`/events/${ev.id}/media-senders`).then((r) => setSenders(r.senders)).catch(() => undefined); }, [ev.id, items.length]);
  useEffect(() => { api.get<{ folders: any[] }>(`/events/${ev.id}/folders`).then((r) => setFolders(r.folders)).catch(() => undefined); }, [ev.id]);

  // live: refresh the list when something changes (staff channel also carries pending items)
  useEffect(() => {
    if (!canModerate) return; let es: EventSource | null = null; let stop = false; let timer: any;
    const connect = async () => {
      try {
        const { ticket } = await api.post<{ ticket: string }>(`/events/${ev.id}/live-ticket`);
        es = new EventSource(`${API_BASE}/v1/live?ticket=${ticket}`);
        const bump = () => { clearTimeout(timer); timer = setTimeout(() => void load(null, true), 600); };
        es.addEventListener('media.updated', bump); es.onerror = () => { es?.close(); if (!stop) setTimeout(connect, 5000); };
      } catch { if (!stop) setTimeout(connect, 8000); }
    };
    void connect(); return () => { stop = true; es?.close(); clearTimeout(timer); };
  }, [ev.id, canModerate, load]);

  const bulk = useAction(async (action: 'approve' | 'reject' | 'hide' | 'restore', ids: string[]) => {
    const r = await api.post<{ results: { ok: boolean }[] }>(`/events/${ev.id}/moderation/bulk`, { action, media_ids: ids });
    toast(`${r.results.filter((x) => x.ok).length}/${ids.length}`); setSel(new Set()); setOpen(null); await load(null, true);
  });
  const one = useAction(async (fn: () => Promise<unknown>) => { await fn(); setOpen(null); await load(null, true); });
  const toggle = (id: string) => setSel((p) => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; });

  // ---- member uploads (host / moderator / photographer) through the same chunked pipeline
  const engine = useMemo(() => {
    const ctk = async () => { const { getAccessToken, refreshSession } = await import('@/lib/api'); return getAccessToken() ?? (await refreshSession()) ?? ''; };
    const wrap = async <T,>(p: Promise<T>) => { try { return await p; } catch (e) { if (e instanceof ApiError) throw new HttpFailure(e.status, e.code); throw new HttpFailure(0, 'network'); } };
    const api2: UploadApi = {
      intent: (body, key) => wrap(api.post<any>(`/events/${ev.id}/uploads/intents`, { ...body, folder_id: folder || undefined }, { 'Idempotency-Key': key })),
      status: (id, token) => wrap(request<any>(`/uploads/${id}`, { headers: { 'X-Upload-Token': token } })),
      putChunk: async (id, n, token, data) => { let r: Response; try { r = await fetch(`${API_BASE}/v1/uploads/${id}/chunks/${n}`, { method: 'PUT', headers: { 'X-Upload-Token': token, 'Content-Type': 'application/octet-stream' }, body: data }); } catch { throw new HttpFailure(0, 'network'); } if (!r.ok) throw new HttpFailure(r.status, (await r.json().catch(() => ({})))?.error?.code ?? 'http_error'); },
      complete: (id, token, key) => wrap(request<any>(`/media/${id}/complete`, { method: 'POST', headers: { 'X-Upload-Token': token, 'Idempotency-Key': key } })),
      cancel: (id, token) => request<void>(`/uploads/${id}`, { method: 'DELETE', headers: { 'X-Upload-Token': token } }).catch(() => undefined),
    };
    void ctk;
    return new UploadEngine({ api: api2, store: createIndexedDbStore(`ep-host-${ev.id.slice(0, 8)}`), concurrency: 3, prepare: prepareImage, isOnline: () => navigator.onLine });
  }, [ev.id, folder]);
  useEffect(() => { const un = engine.subscribe(setQueue); void engine.restore(); const on = () => engine.networkChanged(); window.addEventListener('online', on); return () => { un(); window.removeEventListener('online', on); }; }, [engine]);
  useEffect(() => { if (queue.some((q) => q.state === 'done')) { const h = setTimeout(() => void load(null, true), 1500); return () => clearTimeout(h); } }, [queue, load]);

  const canUpload = ['scheduled', 'live'].includes(ev.state);
  return (
    <div className="stack">
      <div className="row between">
        <div className="row" role="group">{FILTERS.filter((f) => canModerate || ['newest', 'all', 'approved'].includes(f)).map((f) => <button key={f} className={`btn sm ${filter === f ? 'primary' : ''}`} onClick={() => setFilter(f)}>{t(`host.gallery.filter.${f}`)}</button>)}</div>
        <div className="row">
          {senders.length > 1 && <select value={sender} onChange={(e) => setSender(e.target.value)} style={{ width: 'auto' }} aria-label="sender"><option value="">{t('host.gallery.allSenders')}</option>{senders.map((x) => <option key={x.key} value={x.key}>{(x.name ?? t('guest.gallery.unnamed'))} ({x.count})</option>)}</select>}
          <select value={folder} onChange={(e) => setFolder(e.target.value)} style={{ width: 'auto' }} aria-label="folder"><option value="">{t('host.gallery.allFolders')}</option>{folders.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}</select>
          {canUpload && <><input ref={fileRef} type="file" accept="image/*,.heic" multiple hidden onChange={async (e) => { for (const f of [...(e.target.files ?? [])]) await engine.add(f, { dataSaver: false }); e.target.value = ''; }} /><button className="btn sm" onClick={() => fileRef.current?.click()}>⬆ {t('host.gallery.upload')}</button></>}
          {canModerate && <button className="btn sm ghost" onClick={async () => setLogs((await api.get<{ logs: any[] }>(`/events/${ev.id}/moderation/logs`)).logs)}>{t('host.gallery.logs')}</button>}
        </div>
      </div>
      {queue.filter((q) => q.state !== 'cancelled').length > 0 && (
        <div className="card stack">{queue.map((q) => <div key={q.id} className="row between small"><span>{(q.size / 1048576).toFixed(1)} MB</span><span>{q.state === 'failed' ? `${t('guest.queue.failed')}: ${q.error}` : q.state === 'done' ? '✓' : `${q.progress}%`}</span>{q.state === 'failed' && <button className="btn sm" onClick={() => engine.retry(q.id)}>{t('common.retry')}</button>}{['done', 'failed'].includes(q.state) && <button className="btn sm ghost" onClick={() => engine.remove(q.id)}>✕</button>}</div>)}</div>
      )}
      {canModerate && sel.size > 0 && (
        <div className="card row" style={{ position: 'sticky', top: 56, zIndex: 10 }}>
          <strong>{t('host.gallery.selected', { n: sel.size })}</strong><span className="grow" />
          <button className="btn sm primary" disabled={bulk.pending} onClick={() => bulk.run('approve', [...sel])}>{t('host.gallery.approve')}</button>
          <button className="btn sm danger" disabled={bulk.pending} onClick={() => bulk.run('reject', [...sel])}>{t('host.gallery.reject')}</button>
          <button className="btn sm" disabled={bulk.pending} onClick={() => bulk.run('hide', [...sel])}>{t('host.gallery.hide')}</button>
          <button className="btn sm ghost" onClick={() => setSel(new Set())}>✕</button>
        </div>
      )}
      <ErrorBox error={error ?? bulk.error ?? one.error} />
      {!loading && items.length === 0 && <div className="card center muted">{t('common.noData')}</div>}
      <div className="masonry pin">
        {items.map((it) => (
          <div key={it.id} className={`tile ${sel.has(it.id) ? 'picked' : ''}`} style={{ aspectRatio: it.width && it.height ? `${it.width} / ${it.height}` : '1' }}>
            {it.urls ? <img loading="lazy" decoding="async" src={it.urls.thumb} alt="" width={it.width} height={it.height} onClick={() => setOpen(it)} /> : <div className="center small muted" style={{ padding: 20 }}>{it.upload_state === 'failed' ? t('host.gallery.failed', { reason: it.failure_code ?? '' }) : t('host.gallery.processing')}</div>}
            <span className="tag"><StateBadge state={it.moderation_state} label={it.upload_state === 'ready' ? t(`host.gallery.filter.${it.moderation_state === 'deleted' ? 'hidden' : it.moderation_state}`) : it.upload_state} /></span>
            {it.sender?.name && <span className="who">{it.sender.name}</span>}
            {canModerate && it.upload_state === 'ready' && <button className="sel" aria-label="select" onClick={() => toggle(it.id)}>{sel.has(it.id) ? '✓' : ''}</button>}
          </div>
        ))}
      </div>
      {loading && <Spinner />}
      {cursor && !loading && <button className="btn" onClick={() => load(cursor, false)}>{t('common.loadMore')}</button>}
      {open && open.urls && (
        <Modal title={t('host.tab.gallery')} onClose={() => setOpen(null)}>
          <div className="stack">
            <img src={open.urls.viewer} alt="" style={{ maxHeight: '55vh', objectFit: 'contain', width: '100%' }} />
            <div className="row"><StateBadge state={open.moderation_state} />{open.open_reports > 0 && <span className="badge bad">{t('host.gallery.reports', { n: open.open_reports })}</span>}{open.near_duplicate && <span className="badge warn">{t('host.gallery.nearDuplicate')}</span>}</div>
            <div className="row">
              {canModerate && ['pending', 'rejected', 'flagged', 'hidden'].includes(open.moderation_state) && <button className="btn primary" onClick={() => bulk.run('approve', [open.id])}>{t(open.moderation_state === 'pending' ? 'host.gallery.approve' : 'host.gallery.restore')}</button>}
              {canModerate && ['pending', 'approved', 'flagged'].includes(open.moderation_state) && <button className="btn danger" onClick={() => bulk.run('reject', [open.id])}>{t('host.gallery.reject')}</button>}
              {canModerate && open.moderation_state === 'approved' && <button className="btn" onClick={() => bulk.run('hide', [open.id])}>{t('host.gallery.hide')}</button>}
              <button className="btn" onClick={() => one.run(() => api.patch(`/media/${open.id}`, { is_highlight: !open.is_highlight }))}>★ {t(open.is_highlight ? 'host.gallery.unhighlight' : 'host.gallery.highlight')}</button>
              {folders.length > 0 && <select aria-label={t('host.gallery.moveTo')} value={open.folder_id ?? ''} onChange={(e) => one.run(() => api.patch(`/media/${open.id}`, { folder_id: e.target.value || null }))} style={{ width: 'auto' }}><option value="">{t('host.gallery.moveTo')}</option>{folders.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}</select>}
              {canModerate && open.uploader === 'guest' && <button className="btn" onClick={() => { if (window.confirm(t('host.gallery.block') + '?')) one.run(() => api.post(`/media/${open.id}/block-uploader`, { hide_media: true, reason: 'blocked by host' })); }}>⛔ {t('host.gallery.block')}</button>}
            </div>
          </div>
        </Modal>
      )}
      {logs && <Modal title={t('host.gallery.logs')} onClose={() => setLogs(null)}><div className="table-wrap"><table><tbody>{logs.map((l) => <tr key={l.id}><td className="small">{new Date(l.created_at).toLocaleString()}</td><td>{l.actor_type}</td><td>{l.action}</td><td className="small">{l.from_state} → {l.to_state}</td></tr>)}</tbody></table></div></Modal>}
    </div>
  );
}
