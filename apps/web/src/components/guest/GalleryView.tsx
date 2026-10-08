'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, GuestSession, request } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { ErrorBox, Modal, SkeletonWall, Spinner, useAction, useToast } from '@/components/ui';

interface Sender { key: string; name: string | null }
interface Item {
  id: string; width: number; height: number; published_at: string; is_highlight: boolean; caption?: string | null; folder_id?: string | null; mine: boolean; can_download: boolean;
  sender?: Sender | null; urls: { thumb: string; gallery: string; viewer: string };
}
interface Board { key: string; name: string | null; count: number; covers: string[]; mine?: boolean }
type View = 'all' | 'highlights' | 'people' | 'albums' | 'mine';

/**
 * Event-scoped gallery, Pinterest-style: a seamless masonry wall plus "boards" for people (by sender name) and albums.
 * Cursor pagination, lazy fade-in images, live updates over SSE, full-screen swipe viewer.
 */
export function GalleryView({ session, ctx, onBack, onAuthLost }: { session: GuestSession; ctx: { downloads_enabled: boolean; show_uploader_names?: boolean; event: { name: string } }; onBack: () => void; onAuthLost: () => void }) {
  const { t } = useI18n(); const toast = useToast();
  const namesOn = ctx.show_uploader_names !== false;
  const [view, setView] = useState<View>('all');
  const [sender, setSender] = useState<Sender | null>(null); const [album, setAlbum] = useState<{ id: string; name: string } | null>(null);
  const [showNames, setShowNames] = useState(true);
  const [items, setItems] = useState<Item[]>([]); const [cursor, setCursor] = useState<string | null>(null); const [loading, setLoading] = useState(true); const [done, setDone] = useState(false);
  const [error, setError] = useState<unknown>(null); const [open, setOpen] = useState<number | null>(null);
  const [people, setPeople] = useState<{ senders: Board[]; unnamed: number } | null>(null); const [albums, setAlbums] = useState<Board[] | null>(null);
  const [fresh, setFresh] = useState(0);
  const sentinel = useRef<HTMLDivElement>(null); const busy = useRef(false); const reqId = useRef(0);

  const boardMode = (view === 'people' && !sender) || (view === 'albums' && !album);
  const filterKey = `${view}|${sender?.key ?? ''}|${album?.id ?? ''}`;
  const q = (cur: string | null) => {
    const p = new URLSearchParams({ limit: '24' });
    if (cur) p.set('cursor', cur);
    if (album) p.set('folder_id', album.id);
    if (sender) p.set('sender', sender.key);
    if (view === 'highlights') p.set('highlights', 'true');
    if (view === 'mine') p.set('mine', 'true');
    return `/guest/media?${p.toString()}`;
  };

  const fail = (e: unknown) => { if (e instanceof ApiError && [401, 403].includes(e.status) && e.code !== 'scope_not_granted') onAuthLost(); setError(e); };
  const load = useCallback(async (cur: string | null, replace = false) => {
    if (busy.current && !replace) return; busy.current = true; setLoading(true); const my = ++reqId.current;
    try {
      const r = await request<{ items: Item[]; next_cursor: string | null }>(q(cur), { token: session.token });
      if (my !== reqId.current) return; // a newer filter/tab replaced this request
      setItems((prev) => (replace ? r.items : [...prev, ...r.items.filter((n) => !prev.some((p) => p.id === n.id))]));
      setCursor(r.next_cursor); setDone(!r.next_cursor); setError(null);
    } catch (e) { fail(e); }
    finally { if (my === reqId.current) { setLoading(false); busy.current = false; } }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.token, filterKey]);

  useEffect(() => {
    setItems([]); setCursor(null); setDone(false);
    if (boardMode) { setLoading(false); return; }
    void load(null, true);
  }, [load, boardMode]);

  useEffect(() => {
    if (view === 'people' && !sender && !people) request<{ enabled: boolean; senders: Board[]; unnamed: number }>('/guest/senders', { token: session.token }).then((r) => setPeople({ senders: r.senders, unnamed: r.unnamed })).catch(fail);
    if (view === 'albums' && !album && !albums) request<{ folders: { id: string; name: string; count: number; covers: string[] }[] }>('/guest/folders', { token: session.token }).then((r) => setAlbums(r.folders.map((f) => ({ key: f.id, name: f.name, count: f.count, covers: f.covers })))).catch(fail);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, sender, album]);

  // infinite scroll: only fetch the next page when the sentinel is near the viewport
  useEffect(() => {
    const el = sentinel.current; if (!el) return;
    const io = new IntersectionObserver((es) => { if (es[0].isIntersecting && cursor && !done) void load(cursor); }, { rootMargin: '800px' });
    io.observe(el); return () => io.disconnect();
  }, [cursor, done, load]);

  // ---- live updates (SSE with single-use ticket; reconnects with backoff)
  const filtered = view !== 'all' || !!sender || !!album;
  useEffect(() => {
    let es: EventSource | null = null; let stop = false; let retry = 0;
    const connect = async () => {
      try {
        const { ticket } = await request<{ ticket: string }>('/guest/live-ticket', { method: 'POST', json: {}, token: session.token });
        es = new EventSource(`${process.env.NEXT_PUBLIC_API_BASE ?? ''}/v1/live?ticket=${ticket}`);
        es.addEventListener('media.published', (ev) => {
          const m = JSON.parse((ev as MessageEvent).data).media as Item;
          setPeople(null); setAlbums(null);
          if (filtered) { setFresh((n) => n + 1); return; }
          setItems((prev) => (prev.some((p) => p.id === m.id) ? prev : [{ ...m, caption: null, mine: false, can_download: true, is_highlight: false } as Item, ...prev])); setFresh((n) => n + 1);
        });
        es.addEventListener('media.removed', (ev) => { const id = JSON.parse((ev as MessageEvent).data).media_id; setItems((prev) => prev.filter((p) => p.id !== id)); });
        es.onopen = () => { retry = 0; };
        es.onerror = () => { es?.close(); if (!stop) setTimeout(connect, Math.min(30000, 1000 * 2 ** retry++)); };
      } catch { if (!stop) setTimeout(connect, Math.min(30000, 2000 * 2 ** retry++)); }
    };
    void connect();
    return () => { stop = true; es?.close(); };
  }, [session.token, filtered]);

  // ---- viewer
  const current = open !== null ? items[open] : null;
  useEffect(() => { if (open !== null && items[open + 1]) { const i = new Image(); i.src = items[open + 1].urls.viewer; } }, [open, items]);       // preload only the next one
  useEffect(() => {
    if (open === null) return;
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(null); if (e.key === 'ArrowRight') setOpen((o) => (o !== null && o < items.length - 1 ? o + 1 : o)); if (e.key === 'ArrowLeft') setOpen((o) => (o !== null && o > 0 ? o - 1 : o)); };
    window.addEventListener('keydown', k); document.body.style.overflow = 'hidden';
    return () => { window.removeEventListener('keydown', k); document.body.style.overflow = ''; };
  }, [open, items.length]);

  const go = (v: View) => { setView(v); setSender(null); setAlbum(null); window.scrollTo({ top: 0 }); };
  const tabs: { id: View; label: string }[] = [
    { id: 'all', label: t('guest.gallery.all') },
    ...(namesOn ? [{ id: 'people' as View, label: t('guest.gallery.people') }] : []),
    { id: 'albums', label: t('guest.gallery.albums') },
    { id: 'highlights', label: `★ ${t('guest.gallery.highlights')}` },
    { id: 'mine', label: t('guest.gallery.mine') },
  ];
  const heading = sender ? (sender.name ?? t('guest.gallery.unnamed')) : album ? album.name : null;

  return (
    <div className="gwall">
      <div className="gbar">
        <div className="row between" style={{ padding: '2px 2px 8px' }}>
          <button className="btn sm" onClick={onBack}>← {t('common.back')}</button>
          <div className="row" style={{ gap: 8 }}>
            {namesOn && !boardMode && <label className="check small"><input type="checkbox" checked={showNames} onChange={(e) => setShowNames(e.target.checked)} /><span>{t('guest.gallery.names')}</span></label>}
            <span className="badge ok">● {t('guest.gallery.live')}</span>
          </div>
        </div>
        <div className="gtabs" role="tablist">
          {tabs.map((x) => <button key={x.id} role="tab" aria-selected={view === x.id} className={`chip ${view === x.id ? 'on' : ''}`} onClick={() => go(x.id)}>{x.label}</button>)}
        </div>
      </div>

      {heading && (
        <div className="gtitle">
          <button className="btn sm" onClick={() => { setSender(null); setAlbum(null); }}>← {view === 'people' ? t('guest.gallery.people') : t('guest.gallery.albums')}</button>
          <h2>{heading}</h2>
        </div>
      )}
      <ErrorBox error={error} />

      {boardMode && view === 'people' && (
        !people ? <Spinner /> : people.senders.length === 0
          ? <div className="card center muted">{t('guest.gallery.noPeople')}</div>
          : <div className="boards">{people.senders.map((b) => <BoardCard key={b.key} board={b} suffix={b.mine ? ` · ${t('guest.gallery.you')}` : ''} onOpen={() => setSender({ key: b.key, name: b.name })} />)}</div>
      )}
      {boardMode && view === 'albums' && (
        !albums ? <Spinner /> : albums.length === 0
          ? <div className="card center muted">{t('guest.gallery.noAlbums')}</div>
          : <div className="boards">{albums.map((b) => <BoardCard key={b.key} board={b} onOpen={() => setAlbum({ id: b.key, name: b.name ?? '' })} />)}</div>
      )}

      {!boardMode && (
        <>
          {!loading && items.length === 0 && !error && <div className="card center muted">{t('guest.gallery.empty')}</div>}
          <div className="masonry pin">
            {items.map((it, i) => (
              <button key={it.id} className="tile" onClick={() => setOpen(i)} style={{ aspectRatio: `${it.width} / ${it.height}` }} aria-label={`${t('guest.gallery.title')} ${i + 1}`}>
                <img loading="lazy" decoding="async" src={it.urls.thumb} srcSet={`${it.urls.thumb} 480w, ${it.urls.gallery} 1280w`} sizes="(min-width: 1200px) 20vw, (min-width: 900px) 25vw, (min-width: 560px) 33vw, 50vw" width={it.width} height={it.height} alt={it.caption ?? ''}
                  onLoad={(e) => e.currentTarget.classList.add('ld')} ref={(el) => { if (el?.complete) el.classList.add('ld'); }} />
                {it.is_highlight && <span className="star" aria-hidden>★</span>}
                {showNames && namesOn && (it.sender?.name || it.mine) && <span className="who">{it.mine ? t('guest.gallery.you') : it.sender?.name}</span>}
              </button>
            ))}
          </div>
          <div ref={sentinel} />
          {loading && items.length === 0 && <SkeletonWall />}
          {loading && items.length > 0 && <Spinner />}
          {!done && !loading && cursor && <button className="btn" onClick={() => load(cursor)}>{t('common.loadMore')}</button>}
        </>
      )}
      {fresh > 0 && <span className="sr-only" role="status">{t('guest.gallery.newPhotos')}</span>}
      {current && <Viewer item={current} index={open!} total={items.length} downloadsOn={ctx.downloads_enabled} namesOn={namesOn} session={session} eventName={ctx.event.name} onClose={() => setOpen(null)}
        onMore={(s) => { setOpen(null); setView('people'); setSender(s); window.scrollTo({ top: 0 }); }}
        onPrev={() => setOpen((o) => (o ? o - 1 : o))} onNext={() => setOpen((o) => (o !== null && o < items.length - 1 ? o + 1 : o))} toast={toast} />}
    </div>
  );
}

/** A "board": cover collage (1 large + 2 small), title and photo count. */
function BoardCard({ board, suffix = '', onOpen }: { board: Board; suffix?: string; onOpen: () => void }) {
  const { t } = useI18n();
  const [a, b, c] = board.covers;
  return (
    <button className="board" onClick={onOpen}>
      <div className="collage">
        {a ? <img className="c0" src={a} alt="" loading="lazy" /> : <span className="c0" />}
        {b ? <img className="c1" src={b} alt="" loading="lazy" /> : <span className="c1" />}
        {c ? <img className="c2" src={c} alt="" loading="lazy" /> : <span className="c2" />}
      </div>
      <strong>{board.name ?? t('guest.gallery.unnamed')}{suffix}</strong>
      <span className="small muted">{board.count} {t('guest.gallery.photos')}</span>
    </button>
  );
}

function Viewer({ item, index, total, downloadsOn, namesOn, session, eventName, onClose, onPrev, onNext, onMore, toast }: {
  item: Item; index: number; total: number; downloadsOn: boolean; namesOn: boolean; session: GuestSession; eventName: string; onClose: () => void; onPrev: () => void; onNext: () => void; onMore: (s: Sender) => void; toast: (m: string) => void;
}) {
  const { t } = useI18n();
  const touch = useRef<{ x: number; y: number } | null>(null);
  const [report, setReport] = useState(false);
  const save = useAction(async (variant: 'viewer' | 'original') => {
    const r = await request<{ url: string; filename: string }>(`/guest/media/${item.id}/download-link?variant=${variant}`, { token: session.token });
    const a = document.createElement('a'); a.href = r.url; a.download = r.filename; document.body.appendChild(a); a.click(); a.remove();
  });
  const share = useAction(async () => {
    // OS share sheet (WhatsApp, Telegram, ...): share the optimized photo as a file when supported
    const res = await fetch(item.urls.gallery); const blob = await res.blob(); const file = new File([blob], 'photo.jpg', { type: 'image/jpeg' });
    const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
    if (nav.share && nav.canShare?.({ files: [file] })) { await nav.share({ files: [file], title: eventName }); await request('/guest/analytics', { method: 'POST', json: { metric: 'share' }, token: session.token }).catch(() => undefined); toast(t('guest.viewer.shared')); }
    else if (item.can_download) await save.run('viewer');
  });
  const who = namesOn && item.sender?.name ? item.sender : null;
  return (
    <div className="viewer" role="dialog" aria-modal="true" aria-label={t('guest.gallery.title')}
      onTouchStart={(e) => { touch.current = { x: e.touches[0].clientX, y: e.touches[0].clientY }; }}
      onTouchEnd={(e) => { const s = touch.current; if (!s) return; const dx = e.changedTouches[0].clientX - s.x; const dy = e.changedTouches[0].clientY - s.y; if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) (dx < 0 ? onNext : onPrev)(); else if (dy > 120) onClose(); touch.current = null; }}>
      <div className="row between" style={{ padding: 10 }}><span className="small">{index + 1} / {total}</span><button className="btn sm" onClick={onClose} aria-label={t('common.close.esc')}>✕</button></div>
      <div className="stage"><img src={item.urls.viewer} srcSet={`${item.urls.gallery} 1280w, ${item.urls.viewer} 2560w`} sizes="100vw" alt={item.caption ?? ''} /></div>
      {(who || item.caption) && (
        <div className="vmeta">
          {who && <button className="who-pill" onClick={() => onMore(who)}>{who.name} · {t('guest.gallery.moreFrom')} ›</button>}
          {item.caption && <p className="small" style={{ margin: 0 }}>{item.caption}</p>}
        </div>
      )}
      <div className="bar">
        <button className="btn" onClick={onPrev} disabled={index === 0}>‹ {t('guest.viewer.prev')}</button>
        {downloadsOn && item.can_download ? <button className="btn" onClick={() => save.run('viewer')} disabled={save.pending}>⬇ {t('guest.viewer.save')}</button> : <span className="small" style={{ alignSelf: 'center' }}>{t('guest.viewer.downloadOff')}</span>}
        <button className="btn" onClick={() => share.run()} disabled={share.pending}>↗ {t('guest.viewer.share')}</button>
        <button className="btn" onClick={() => setReport(true)}>⚑ {t('common.report')}</button>
        <button className="btn" onClick={onNext} disabled={index >= total - 1}>{t('guest.viewer.next')} ›</button>
      </div>
      {!!(save.error || share.error) && <div style={{ padding: 8 }}><ErrorBox error={save.error ?? share.error} /></div>}
      {report && <ReportDialog mediaId={item.id} session={session} onClose={() => setReport(false)} onSent={() => { setReport(false); toast(t('guest.report.thanks')); }} />}
    </div>
  );
}

const REASONS = ['inappropriate', 'privacy_concern', 'impersonation', 'copyright', 'other'] as const;
function ReportDialog({ mediaId, session, onClose, onSent }: { mediaId: string; session: GuestSession; onClose: () => void; onSent: () => void }) {
  const { t } = useI18n();
  const [reason, setReason] = useState<(typeof REASONS)[number]>('inappropriate'); const [details, setDetails] = useState('');
  const send = useAction(async () => { await request(`/media/${mediaId}/report`, { method: 'POST', json: { reason, details: details || undefined }, token: session.token }); onSent(); });
  return (
    <Modal title={t('guest.report.title')} onClose={onClose}>
      <div className="stack" style={{ color: 'var(--ink)' }}>
        {REASONS.map((r) => <label key={r} className="check"><input type="radio" name="reason" checked={reason === r} onChange={() => setReason(r)} /><span>{t(`guest.report.${r}`)}</span></label>)}
        <label className="field"><span>{t('guest.report.details')}</span><textarea value={details} maxLength={500} onChange={(e) => setDetails(e.target.value)} /></label>
        <ErrorBox error={send.error} />
        <p className="small"><a href="/privacy">{t('common.privacy')}</a></p>
        <button className="btn primary" onClick={() => send.run()} disabled={send.pending}>{t('guest.report.send')}</button>
      </div>
    </Modal>
  );
}
