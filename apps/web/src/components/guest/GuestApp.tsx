'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, API_BASE, GuestSession, clearGuest, formatBytes, loadGuest, request, saveGuest } from '@/lib/api';
import { formatDate } from '@/lib/ethiopian';
import { LangSwitch, errorMessage, useI18n } from '@/lib/i18n';
import { HttpFailure, UploadEngine, createIndexedDbStore, estimateBytes, prepareImage, type QueueItem, type UploadApi } from '@/lib/upload-queue';
import { ErrorBox, Field, Modal, Spinner, ToastProvider, Topbar, useAction } from '@/components/ui';
import { sampleCover } from '@/lib/samples';
import { GalleryView } from './GalleryView';
import { UploadPanel } from './UploadPanel';

interface Ctx {
  locator_kind: string; status: 'open' | 'not_started' | 'closed' | 'unavailable';
  event: { name: string; type: string; host_name?: string; venue?: string; city: string; starts_at: string; language: 'en' | 'am'; cover_url?: string | null; brand_color?: string | null };
  scopes: { scope: 'upload' | 'gallery'; mode: string; credential: 'none' | 'code' | 'passcode' | 'otp'; credential_satisfied_by_locator: boolean }[];
  can_upload: boolean; guest_name_required: boolean; captions_enabled: boolean; downloads_enabled: boolean; show_uploader_names?: boolean; slideshow_enabled: boolean;
  notice: { version: string; title: string; body: string; legal_status: string } | null;
  limits: { max_bytes: number; allowed_mime: string[]; chunk_bytes: number; caption_max: number };
}
type View = 'home' | 'preview' | 'gallery' | 'mine';

const toFailure = (e: unknown): never => { if (e instanceof ApiError) throw new HttpFailure(e.status, e.code); throw new HttpFailure(0, 'network'); };

function deviceId(): string {
  try { let d = localStorage.getItem('ep.device'); if (!d) { d = crypto.randomUUID(); localStorage.setItem('ep.device', d); } return d; } catch { return ''; }
}

export function GuestApp({ locator }: { locator: string }) {
  const { t, lang, setLang } = useI18n();
  const [ctx, setCtx] = useState<Ctx | null>(null);
  const [loadErr, setLoadErr] = useState<unknown>(null);
  const [session, setSession] = useState<GuestSession | null>(null);
  const [view, setView] = useState<View>('home');
  const [picked, setPicked] = useState<File[]>([]);
  const [items, setItems] = useState<QueueItem[]>([]);
  const [dataSaver, setDataSaver] = useState(false);
  const [sheet, setSheet] = useState(false);
  const cam = useRef<HTMLInputElement>(null); const pick = useRef<HTMLInputElement>(null);
  const sessionRef = useRef<GuestSession | null>(null); sessionRef.current = session;

  // ---- context
  useEffect(() => {
    let alive = true;
    request<Ctx>(`/events/${encodeURIComponent(locator)}/context?lang=${lang}`).then((c) => { if (alive) setCtx(c); }).catch((e) => alive && setLoadErr(e));
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locator]);
  useEffect(() => { if (ctx && !localStorage.getItem('ep.lang')) setLang(ctx.event.language); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [ctx?.event.language]);
  useEffect(() => {
    try {
      const saved = localStorage.getItem('ep.datasaver');
      const conn = (navigator as any).connection;
      setDataSaver(saved !== null ? saved === '1' : !!(conn?.saveData || /(^|-)2g|3g/.test(conn?.effectiveType ?? '')));
    } catch { /* default off */ }
  }, []);
  useEffect(() => { try { localStorage.setItem('ep.datasaver', dataSaver ? '1' : '0'); } catch { /* ignore */ } }, [dataSaver]);

  // ---- saved session (refreshed if it will expire within an hour)
  useEffect(() => {
    const g = loadGuest(locator); if (!g) return;
    setSession(g);
    if (g.expiresAt - Date.now() < 3600_000) {
      request<{ token: string; expires_in: number; scopes: any }>('/guest/refresh', { method: 'POST', json: {}, token: g.token })
        .then((r) => { const n = { ...g, token: r.token, scopes: r.scopes, expiresAt: Date.now() + r.expires_in * 1000 }; saveGuest(locator, n); setSession(n); })
        .catch((e) => { if (e instanceof ApiError && [401, 403].includes(e.status)) { clearGuest(locator); setSession(null); } });
    }
  }, [locator]);

  // ---- upload engine bound to the current session
  const engine = useMemo(() => {
    const tok = () => sessionRef.current?.token ?? '';
    const chunkHeaders = (token: string) => ({ 'X-Upload-Token': token });
    const api: UploadApi = {
      intent: (body, key) => request<any>('/guest/uploads/intents', { method: 'POST', json: body, token: tok(), headers: { 'Idempotency-Key': key } }).catch(toFailure),
      status: (id, token) => request<any>(`/uploads/${id}`, { headers: chunkHeaders(token) }).catch(toFailure),
      putChunk: async (id, n, token, data) => {
        let res: Response;
        try { res = await fetch(`${API_BASE}/v1/uploads/${id}/chunks/${n}`, { method: 'PUT', headers: { ...chunkHeaders(token), 'Content-Type': 'application/octet-stream' }, body: data }); } catch { throw new HttpFailure(0, 'network'); }
        if (!res.ok) { const b = await res.json().catch(() => ({})); throw new HttpFailure(res.status, b?.error?.code ?? 'http_error'); }
      },
      complete: (id, token, key) => request<any>(`/media/${id}/complete`, { method: 'POST', headers: { ...chunkHeaders(token), 'Idempotency-Key': key } }).catch(toFailure),
      cancel: (id, token) => request<void>(`/uploads/${id}`, { method: 'DELETE', headers: chunkHeaders(token) }).catch(() => undefined),
    };
    return new UploadEngine({ api, store: createIndexedDbStore(`ep-queue-${locator.slice(0, 10)}`), concurrency: 2, isOnline: () => (typeof navigator === 'undefined' ? true : navigator.onLine), prepare: prepareImage });
  }, [locator]);
  useEffect(() => {
    const un = engine.subscribe(setItems);
    engine.restore();
    const on = () => engine.networkChanged();
    window.addEventListener('online', on);
    return () => { un(); window.removeEventListener('online', on); };
  }, [engine]);

  // ---- server-side moderation state of my uploads
  const refreshMine = useCallback(async () => {
    const s = sessionRef.current; if (!s) return;
    try {
      const me = await request<{ uploads: { id: string; state: string }[] }>('/guest/me', { token: s.token });
      for (const it of engine.list()) if (it.mediaId) { const u = me.uploads.find((x) => x.id === it.mediaId); if (u && u.state !== it.serverState) engine.setServerState(it.id, u.state); }
    } catch { /* offline: try next tick */ }
  }, [engine]);
  useEffect(() => {
    if (!session || !items.some((i) => i.state === 'done' && (!i.serverState || ['uploaded', 'processing', 'pending'].includes(i.serverState)))) return;
    const h = setInterval(refreshMine, 4000); return () => clearInterval(h);
  }, [items, session, refreshMine]);

  // ---- render
  if (loadErr) return <Shell><div className="narrow stack" style={{ paddingTop: 24 }}><ErrorBox error={loadErr} /><a className="btn" href="/join">{t('guest.joinByCode.title')}</a></div></Shell>;
  if (!ctx) return <Shell><Spinner /></Shell>;

  const hasUpload = !!session?.scopes.includes('upload');
  const hasGallery = !!session?.scopes.includes('gallery');
  const dates = formatDate(ctx.event.starts_at, lang);
  const canUploadNow = hasUpload && ctx.can_upload;
  const accent = ctx.event.brand_color ? { background: `linear-gradient(135deg, ${ctx.event.brand_color}, #3a0009)` } : undefined;

  const hero = (
    <div className="hero bleed" style={accent}>
      <img className="cover" src={ctx.event.cover_url || sampleCover(ctx.event.type)} alt="" loading="eager" onError={(e) => { const el = e.currentTarget; if (!el.dataset.fb) { el.dataset.fb = '1'; el.src = sampleCover(ctx.event.type); } }} />
      <div className="inner">
        <h1>{ctx.event.name}</h1>
        <p style={{ margin: 0 }}>{ctx.event.host_name ? t('guest.landing.hostedBy', { host: ctx.event.host_name }) : ctx.event.city}</p>
        <p className="small" style={{ margin: 0 }}>{lang === 'am' ? dates.ethiopian : dates.gregorian}{ctx.event.venue ? ` · ${ctx.event.venue}` : ''}</p>
      </div>
    </div>
  );

  let body;
  if (ctx.status === 'unavailable') body = <div className="alert warn">{t('guest.status.unavailable')}</div>;
  else if (!session) body = <JoinForm ctx={ctx} locator={locator} onJoined={(s) => { saveGuest(locator, s); setSession(s); }} />;
  else if (view === 'gallery' && hasGallery) body = <GalleryView session={session} ctx={ctx} onBack={() => setView('home')} onAuthLost={() => { clearGuest(locator); setSession(null); }} />;
  else if (view === 'preview' && picked.length) {
    body = (
      <UploadPanel
        files={picked} items={items} captionsEnabled={ctx.captions_enabled} captionMax={ctx.limits.caption_max} maxBytes={ctx.limits.max_bytes} dataSaver={dataSaver} onDataSaver={setDataSaver}
        onCancel={() => { setPicked([]); setView('home'); }}
        onRemove={(i) => setPicked((p) => p.filter((_, k) => k !== i))}
        onUpload={async (caption) => { const fs = picked; setPicked([]); setView('home'); for (const f of fs) await engine.add(f, { dataSaver, caption: caption || undefined }); }}
      />
    );
  } else {
    body = (
      <Home ctx={ctx} session={session} items={items} engine={engine} dataSaver={dataSaver} onDataSaver={setDataSaver}
        openCam={() => cam.current?.click()} openPick={() => pick.current?.click()} onGallery={() => setView('gallery')}
        onSession={(s) => { saveGuest(locator, s); setSession(s); }} refreshMine={refreshMine} hasUpload={hasUpload} hasGallery={hasGallery} />
    );
  }
  return (
    <Shell>
      <div className="narrow stack guest-page" style={{ paddingTop: 0, paddingBottom: 110 }}>
        {view !== 'gallery' && hero}
        {ctx.status === 'not_started' && <div className="alert">{t('guest.status.not_started')}</div>}
        {ctx.status === 'closed' && <div className="alert">{t('guest.status.closed')}</div>}
        {body}
        <p className="small center muted"><a href="/privacy">{t('common.privacy')}</a> · {t('common.poweredBy')}</p>
      </div>
      {session && canUploadNow && (
        <>
          <input ref={cam} type="file" accept="image/*" capture="environment" hidden onChange={(e) => { const f = [...(e.target.files ?? [])]; e.target.value = ''; if (f.length) { setPicked(f); setView('preview'); setSheet(false); } }} />
          <input ref={pick} type="file" accept={ctx.limits.allowed_mime.join(',') + ',.heic,.heif'} multiple hidden onChange={(e) => { const f = [...(e.target.files ?? [])]; e.target.value = ''; if (f.length) { setPicked(f); setView('preview'); setSheet(false); } }} />
        </>
      )}
      {session && view !== 'preview' && (
        <nav className="gnav" aria-label="navigation">
          <button className={view !== 'gallery' ? 'on' : ''} onClick={() => setView('home')}><span aria-hidden>⌂</span><b>{t('guest.nav.home')}</b></button>
          {canUploadNow && <button className="plus" onClick={() => setSheet(true)} aria-label={t('guest.nav.add')}><span aria-hidden>＋</span></button>}
          {hasGallery && <button className={view === 'gallery' ? 'on' : ''} onClick={() => setView('gallery')}><span aria-hidden>▦</span><b>{t('guest.gallery.title')}</b></button>}
        </nav>
      )}
      {sheet && (
        <Modal title={t('guest.nav.add')} onClose={() => setSheet(false)}>
          <div className="stack">
            <button className="btn primary big block" onClick={() => cam.current?.click()}>📷 {t('guest.home.takePhoto')}</button>
            <button className="btn big block" onClick={() => pick.current?.click()}>🖼️ {t('guest.home.choosePhotos')}</button>
          </div>
        </Modal>
      )}
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  const { t } = useI18n();
  return <ToastProvider><Topbar title={t('app.name')} right={<LangSwitch />} />{children}</ToastProvider>;
}

// ---------------------------------------------------------------------------- join
function JoinForm({ ctx, locator, onJoined }: { ctx: Ctx; locator: string; onJoined: (s: GuestSession) => void }) {
  const { t, lang } = useI18n();
  const params = typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : new URLSearchParams();
  const [code, setCode] = useState(params.get('c') ?? '');
  const [passcode, setPasscode] = useState('');
  const [name, setName] = useState('');
  const [agree, setAgree] = useState(false);
  const [phone, setPhone] = useState(''); const [otp, setOtp] = useState(''); const [proof, setProof] = useState<string | null>(null); const [otpSent, setOtpSent] = useState(false);
  const needs = new Set(ctx.scopes.filter((s) => !(s.credential === 'code' && s.credential_satisfied_by_locator)).map((s) => s.credential));
  const hasUpload = ctx.scopes.some((s) => s.scope === 'upload');
  const sendOtp = useAction(async () => { await request(`/events/${encodeURIComponent(locator)}/verify`, { method: 'POST', json: { phone } }); setOtpSent(true); });
  const verify = useAction(async () => { const r = await request<{ verification_proof: string }>(`/events/${encodeURIComponent(locator)}/verify`, { method: 'POST', json: { phone, code: otp } }); setProof(r.verification_proof); });
  const join = useAction(async () => {
    const body: Record<string, unknown> = { device_id: deviceId() };
    if (needs.has('code') && code) body.code = code.trim();
    if (needs.has('passcode')) body.passcode = passcode;
    if (proof) body.verification_proof = proof;
    if (name.trim()) body.display_name = name.trim();
    if (hasUpload && ctx.notice) body.consent = { notice_version: ctx.notice.version, accepted: true };
    const r = await request<{ token: string; expires_in: number; scopes: ('upload' | 'gallery')[]; display_name?: string }>(`/events/${encodeURIComponent(locator)}/join`, { method: 'POST', json: body });
    onJoined({ token: r.token, scopes: r.scopes, display_name: r.display_name, expiresAt: Date.now() + r.expires_in * 1000 });
  });
  const needOtp = needs.has('otp');
  const ready = (!hasUpload || agree) && (!needs.has('code') || code.trim().length >= 6) && (!needs.has('passcode') || passcode.length > 0) && (!needOtp || !!proof) && (!(ctx.guest_name_required && hasUpload) || name.trim().length > 0);
  return (
    <form className="card stack sheetcard" onSubmit={(e) => { e.preventDefault(); void join.run(); }}>
      <h2>{t('guest.landing.invite')}</h2>
      <p className="muted">{t('guest.landing.noAccount')}</p>
      {needs.has('code') && <Field label={t('guest.code.label')} hint={t('guest.code.hint')}><input type="text" inputMode="text" autoCapitalize="characters" autoComplete="off" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} maxLength={12} /></Field>}
      {needs.has('passcode') && <Field label={t('guest.passcode.label')}><input type="password" autoComplete="off" value={passcode} onChange={(e) => setPasscode(e.target.value)} /></Field>}
      {needOtp && (
        <div className="stack">
          <Field label={t('guest.phone.label')}><input type="tel" inputMode="tel" autoComplete="tel" value={phone} onChange={(e) => setPhone(e.target.value)} disabled={!!proof} /></Field>
          {!proof && !otpSent && <button type="button" className="btn" disabled={sendOtp.pending || phone.length < 9} onClick={() => sendOtp.run()}>{t('guest.phone.send')}</button>}
          {otpSent && !proof && <><p className="small muted">{t('guest.phone.sent')}</p><Field label={t('guest.phone.codeLabel')}><input type="text" inputMode="numeric" autoComplete="one-time-code" value={otp} onChange={(e) => setOtp(e.target.value.replace(/\D/g, '').slice(0, 8))} /></Field><button type="button" className="btn" disabled={verify.pending || otp.length < 4} onClick={() => verify.run()}>{t('guest.phone.verify')}</button></>}
          {proof && <span className="badge ok">✓ {t('guest.phone.verify')}</span>}
          <ErrorBox error={sendOtp.error ?? verify.error} />
        </div>
      )}
      {hasUpload && <Field label={`${t('guest.name.label')}${ctx.guest_name_required ? '' : ` (${t('common.optional')})`}`} hint={ctx.guest_name_required ? t('guest.name.required') : t('guest.name.hint')}><input type="text" autoComplete="name" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} /></Field>}
      {hasUpload && ctx.notice && (
        <div className="stack">
          <div className="alert" lang={lang}><strong>{ctx.notice.title}</strong><p style={{ margin: '6px 0 0' }}>{ctx.notice.body}</p>{ctx.notice.legal_status !== 'approved' && <p className="small muted" style={{ margin: '6px 0 0' }}>{t('guest.notice.draft')}</p>}</div>
          <label className="check"><input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} /><span>{t('guest.notice.accept')}</span></label>
        </div>
      )}
      <ErrorBox error={join.error} />
      <button className="btn primary big block" disabled={!ready || join.pending}>{join.pending ? t('guest.joining') : t('guest.join')}</button>
    </form>
  );
}

// ---------------------------------------------------------------------------- home (actions + queue)
function Home(p: {
  ctx: Ctx; session: GuestSession; items: QueueItem[]; engine: UploadEngine; dataSaver: boolean; onDataSaver: (v: boolean) => void; hasUpload: boolean; hasGallery: boolean;
  openCam: () => void; openPick: () => void; onGallery: () => void; onSession: (s: GuestSession) => void; refreshMine: () => Promise<void>;
}) {
  const { t } = useI18n();
  const [unlock, setUnlock] = useState(''); const [code, setCode] = useState('');
  const canUpload = p.hasUpload && p.ctx.can_upload;
  const unlockAct = useAction(async () => {
    const m = /\/j\/([A-Za-z0-9_-]+)/.exec(unlock); const locator = (m ? m[1] : unlock).trim();
    const r = await request<{ token: string; expires_in: number; scopes: ('upload' | 'gallery')[] }>(`/events/${encodeURIComponent(locator)}/join`, { method: 'POST', token: p.session.token, json: { code: code || undefined, passcode: code || undefined, device_id: deviceId() } });
    p.onSession({ token: r.token, scopes: r.scopes, expiresAt: Date.now() + r.expires_in * 1000 });
  });
  const active = p.items.filter((i) => i.state !== 'cancelled');
  const sent = active.filter((i) => i.state === 'done').length;
  return (
    <div className="stack">
      {canUpload ? (
        <div className="stack">
          <div className="actions">
            <button className="action red" onClick={p.openCam}><span aria-hidden>📷</span><b>{t('guest.home.takePhoto')}</b></button>
            <button className="action dark" onClick={p.openPick}><span aria-hidden>🖼️</span><b>{t('guest.home.choosePhotos')}</b></button>
          </div>
          <label className="check card flat"><input type="checkbox" checked={p.dataSaver} onChange={(e) => p.onDataSaver(e.target.checked)} /><span><strong>{t('guest.dataSaver')}</strong><br /><span className="small muted">{t('guest.dataSaver.hint')}</span></span></label>
        </div>
      ) : p.hasUpload ? <div className="alert">{p.ctx.status === 'open' ? t('guest.uploadsOff') : t('guest.status.closed')}</div> : null}

      {p.hasGallery ? <><button className="btn big block" onClick={p.onGallery}>🖼 {t('guest.home.viewGallery')}</button><RecentWall session={p.session} onOpen={p.onGallery} /></> : (
        <form className="card stack" onSubmit={(e) => { e.preventDefault(); void unlockAct.run(); }}>
          <p className="muted small">{t('guest.home.galleryLocked')}</p>
          <Field label={t('guest.home.enterGalleryCode')}><input type="text" value={unlock} onChange={(e) => setUnlock(e.target.value)} placeholder="…/j/g_…" /></Field>
          <Field label={t('guest.code.label')}><input type="text" value={code} onChange={(e) => setCode(e.target.value)} autoComplete="off" /></Field>
          <ErrorBox error={unlockAct.error} />
          <button className="btn" disabled={!unlock || unlockAct.pending}>{t('guest.home.unlock')}</button>
        </form>
      )}

      {active.length > 0 && (
        <section className="stack" aria-live="polite">
          <h2>{t('guest.queue.title')}</h2>
          {sent > 0 && sent === active.length && <div className="alert ok">{t('guest.queue.done', { n: sent })}</div>}
          {active.some((i) => !['done', 'failed'].includes(i.state)) && <p className="small muted">{t('guest.queue.keepOpen')}</p>}
          {active.map((i) => <QueueRow key={i.id} item={i} engine={p.engine} onDeleted={p.refreshMine} session={p.session} />)}
          {canUpload && <p className="small muted">{t('guest.queue.savedDevice')}</p>}
        </section>
      )}
    </div>
  );
}

function QueueRow({ item, engine, session, onDeleted }: { item: QueueItem; engine: UploadEngine; session: GuestSession; onDeleted: () => Promise<void> }) {
  const { t } = useI18n();
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => { const u = URL.createObjectURL(item.blob); setUrl(u); return () => URL.revokeObjectURL(u); }, [item.blob]);
  const server = item.serverState;
  const label =
    item.state === 'preparing' ? t('guest.queue.compressing')
    : item.state === 'queued' ? t('guest.queue.queued')
    : item.state === 'uploading' ? t('guest.queue.uploading', { pct: item.progress })
    : item.state === 'retrying' ? t('guest.queue.retrying', { s: Math.round((item.retryInMs ?? 0) / 1000) })
    : item.state === 'waiting_network' ? t('guest.queue.waitingNetwork')
    : item.state === 'processing' ? t('guest.queue.processing')
    : item.state === 'failed' ? `${t('guest.queue.failed')}: ${errorMessage(t, item.error)}`
    : server === 'approved' ? t('guest.queue.approved') : server === 'pending' ? t('guest.queue.pending') : server === 'rejected' || server === 'deleted' || server === 'hidden' ? t('guest.queue.rejected')
    : server === 'duplicate' ? t('guest.queue.duplicate') : server === 'failed' ? t('guest.queue.failed') : t('guest.queue.processing');
  const inFlight = ['uploading', 'retrying', 'queued', 'waiting_network', 'preparing'].includes(item.state);
  return (
    <div className="qitem">
      {url && <img src={url} alt="" />}
      <div className="grow">
        <div className="small">{formatBytes(item.size)}</div>
        <div role="status">{label}</div>
        {inFlight && <div className="progress" aria-hidden><i style={{ width: `${item.progress}%` }} /></div>}
      </div>
      {inFlight && <button className="btn sm" onClick={() => engine.cancel(item.id)}>{t('guest.queue.cancel')}</button>}
      {item.state === 'failed' && <button className="btn sm" onClick={() => engine.retry(item.id)}>{t('guest.queue.retry')}</button>}
      {['failed', 'cancelled'].includes(item.state) && <button className="btn sm ghost" onClick={() => engine.remove(item.id)}>{t('guest.queue.remove')}</button>}
      {item.state === 'done' && item.mediaId && !['deleted'].includes(server ?? '') && (
        <button className="btn sm ghost" onClick={async () => { try { await request(`/guest/media/${item.mediaId}`, { method: 'DELETE', token: session.token }); await engine.remove(item.id); await onDeleted(); } catch { /* shown by status refresh */ } }}>{t('guest.queue.delete')}</button>
      )}
    </div>
  );
}

/** A small Pinterest-style peek at the newest photos on the home screen; tapping opens the full gallery. */
function RecentWall({ session, onOpen }: { session: GuestSession; onOpen: () => void }) {
  const [items, setItems] = useState<{ id: string; width: number; height: number; urls: { thumb: string } }[]>([]);
  useEffect(() => { request<{ items: any[] }>('/guest/media?limit=8', { token: session.token }).then((r) => setItems(r.items)).catch(() => undefined); }, [session.token]);
  if (!items.length) return null;
  return (
    <div className="peek" aria-hidden>
      {items.map((it) => <button key={it.id} tabIndex={-1} onClick={onOpen} style={{ aspectRatio: `${it.width} / ${it.height}` }}><img loading="lazy" src={it.urls.thumb} alt="" /></button>)}
    </div>
  );
}

export { estimateBytes };
