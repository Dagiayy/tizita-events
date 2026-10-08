'use client';
import { useEffect, useState } from 'react';
import { api, authedBlob, formatBytes } from '@/lib/api';
import { formatDate } from '@/lib/ethiopian';
import { useI18n } from '@/lib/i18n';
import { CopyButton, ErrorBox, Field, Modal, Spinner, StateBadge, useAction, useToast } from '@/components/ui';
import { DateTimeEntry } from '@/components/DateTimeEntry';
import { CoverPicker } from '@/components/CoverPicker';
import { prepareCover } from '@/lib/cover';
import type { EventDto } from './EventConsole';

type Props = { ev: EventDto; reload: () => Promise<void> };
const can = (ev: EventDto, a: string) => ev.allowed_actions.includes(a);

// ---------------------------------------------------------------------------------------------------------------- overview + lifecycle
export function OverviewTab({ ev, reload, goto }: Props & { goto: (t: any) => void }) {
  const { t, lang } = useI18n(); const toast = useToast();
  const [extend, setExtend] = useState(new Date(ev.upload_closes_at)); const [confirm, setConfirm] = useState(''); const [del, setDel] = useState(false);
  const act = useAction(async (fn: () => Promise<unknown>) => { await fn(); await reload(); toast(t('common.saved')); });
  const owner = ev.role === 'owner';
  const win = (iso: string) => formatDate(iso, lang, { time: true });
  const l = ev.lifecycle;
  return (
    <div className="bento">
      <div className="stats">
        <div className="stat"><b>{ev.media_count}</b><span>{t('host.insights.uploads')}</span></div>
        <div className="stat"><b>{formatBytes(ev.usage.used_bytes)}</b><span>{t('host.insights.storage')} · {ev.usage.percent}%</span></div>
        <div className="stat"><b>{ev.entitlement.has_package ? '✓' : '—'}</b><span>{t('host.payment.current')}</span></div>
      </div>
      {ev.usage.alert_level >= 70 && <div className="alert warn">{t('host.insights.storage')}: {ev.usage.percent}%. {t('host.payment.noSilentCharges')}</div>}
      <div className="card stack">
        <div>{t('host.overview.window')}: <strong>{win(ev.upload_opens_at).gregorian}</strong> → <strong>{win(ev.upload_closes_at).gregorian}</strong></div>
        {l.retention_until && <div>{t('host.overview.retention')}: <strong>{formatDate(l.retention_until, lang).gregorian}</strong></div>}
        {l.deletion_deadline && <div className="alert error">{t('host.overview.deletion')}: <strong>{formatDate(l.deletion_deadline, lang).gregorian}</strong></div>}
        {l.legal_hold && <div className="alert warn">Legal hold</div>}
      </div>
      {!ev.entitlement.has_package && ev.state === 'draft' && owner && (
        <div className="card stack"><p>{t('host.overview.payToActivate')}</p>
          <div className="row"><button className="btn primary" onClick={() => goto('payment')}>{t('host.tab.payment')}</button><button className="btn" disabled={act.pending} onClick={() => act.run(() => api.post(`/events/${ev.id}/activate-trial`))}>{t('host.overview.activateTrial')}</button></div></div>
      )}
      {owner && ['draft', 'scheduled', 'live'].includes(ev.state) && <EventDetailsCard ev={ev} reload={reload} />}
      {owner && (
        <div className="card stack">
          <div className="row">
            {can(ev, 'close') && <button className="btn" disabled={act.pending} onClick={() => act.run(() => api.post(`/events/${ev.id}/close`, { mode: 'now' }))}>{t('host.overview.closeNow')}</button>}
            {can(ev, 'archive') && <button className="btn" onClick={() => act.run(() => api.post(`/events/${ev.id}/archive`))}>{t('host.overview.archive')}</button>}
            {can(ev, 'restore') && <button className="btn" onClick={() => act.run(() => api.post(`/events/${ev.id}/restore`))}>{t('host.overview.restore')}</button>}
            {ev.settings.slideshow_enabled && ['live', 'closing', 'read_only'].includes(ev.state) && <SlideshowLink id={ev.id} />}
          </div>
          {can(ev, 'extend') && (
            <div className="stack"><DateTimeEntry label={t('host.overview.extend')} value={extend} onChange={setExtend} />
              <div className="row">
                <button className="btn" disabled={act.pending} onClick={() => act.run(() => api.post(`/events/${ev.id}/extend`, { upload_closes_at: extend.toISOString() }))}>{t('host.overview.extend')}</button>
                {ev.state === 'live' && <button className="btn" disabled={act.pending} onClick={() => act.run(() => api.post(`/events/${ev.id}/close`, { mode: 'schedule', at: extend.toISOString() }))}>{t('host.overview.scheduleClose')}</button>}
              </div></div>
          )}
          <ErrorBox error={act.error} />
          {ev.state === 'deletion_pending' ? <button className="btn" onClick={() => act.run(() => api.post(`/events/${ev.id}/cancel-deletion`))}>{t('host.overview.cancelDeletion')}</button>
            : can(ev, 'request_deletion') && <button className="btn danger" onClick={() => setDel(true)}>{t('host.overview.delete')}</button>}
        </div>
      )}
      {del && (
        <Modal title={t('host.overview.delete')} onClose={() => setDel(false)}>
          <div className="stack"><p>{t('host.overview.deleteHint')}</p><input type="text" value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder={ev.name} />
            <ErrorBox error={act.error} />
            <button className="btn danger" disabled={confirm.trim() !== ev.name.trim() || act.pending} onClick={async () => { await act.run(() => api.post(`/events/${ev.id}/delete`, { confirm_name: confirm })); setDel(false); }}>{t('host.overview.delete')}</button></div>
        </Modal>
      )}
    </div>
  );
}

/** Edit the event's name, place and dates after creation (allowed while draft / scheduled / live). */
function EventDetailsCard({ ev, reload }: Props) {
  const { t } = useI18n(); const toast = useToast();
  const [f, setF] = useState({ name: ev.name, city: ev.city, venue: ev.venue ?? '', host_name: ev.host_name ?? '' });
  const [starts, setStarts] = useState(new Date(ev.starts_at)); const [ends, setEnds] = useState(new Date(ev.ends_at));
  const [opens, setOpens] = useState(new Date(ev.upload_opens_at)); const [closes, setCloses] = useState(new Date(ev.upload_closes_at));
  const save = useAction(async () => {
    await api.patch(`/events/${ev.id}`, {
      name: f.name.trim(), city: f.city.trim(), venue: f.venue.trim() || null, host_name: f.host_name.trim() || null,
      starts_at: starts.toISOString(), ends_at: ends.toISOString(), upload_opens_at: opens.toISOString(), upload_closes_at: closes.toISOString(),
    });
    await reload(); toast(t('common.saved'));
  });
  const set = (k: string, v: string) => setF((p) => ({ ...p, [k]: v }));
  return (
    <form className="card stack" onSubmit={(e) => { e.preventDefault(); void save.run(); }}>
      <h3 style={{ margin: 0 }}>{t('host.details.title')}</h3>
      <Field label={t('host.new.name')}><input type="text" required maxLength={120} value={f.name} onChange={(e) => set('name', e.target.value)} /></Field>
      <div className="row">
        <Field label={t('host.new.city')}><input type="text" required maxLength={80} value={f.city} onChange={(e) => set('city', e.target.value)} /></Field>
        <Field label={t('host.new.venue')}><input type="text" maxLength={160} value={f.venue} onChange={(e) => set('venue', e.target.value)} /></Field>
      </div>
      <Field label={t('host.new.hostName')}><input type="text" maxLength={120} value={f.host_name} onChange={(e) => set('host_name', e.target.value)} /></Field>
      <DateTimeEntry label={t('host.new.start')} value={starts} onChange={setStarts} />
      <DateTimeEntry label={t('host.new.end')} value={ends} onChange={setEnds} />
      <DateTimeEntry label={t('host.details.opens')} value={opens} onChange={setOpens} />
      <DateTimeEntry label={t('host.details.closes')} value={closes} onChange={setCloses} />
      <ErrorBox error={save.error} />
      <div><button className="btn primary" type="submit" disabled={save.pending}>{t('host.details.save')}</button></div>
    </form>
  );
}

function SlideshowLink({ id }: { id: string }) {
  const { t } = useI18n(); const [url, setUrl] = useState<string | null>(null);
  useEffect(() => { api.get<{ slideshow_url: string | null }>(`/events/${id}/share-links`).then((r) => setUrl(r.slideshow_url)).catch(() => undefined); }, [id]);
  return url ? <a className="btn" href={url} target="_blank" rel="noreferrer">▶ {t('host.overview.slideshow')}</a> : null;
}

// ---------------------------------------------------------------------------------------------------------------- share: links, QR, secrets
export function ShareTab({ ev, reload }: Props) {
  const { t } = useI18n(); const toast = useToast();
  const [links, setLinks] = useState<any>(null); const [qr, setQr] = useState<{ upload?: string; gallery?: string }>({}); const [includeCode, setIncludeCode] = useState(true);
  const [pass, setPass] = useState(''); const [revoke, setRevoke] = useState(true);
  const load = async () => { const l = await api.get<any>(`/events/${ev.id}/share-links`); setLinks(l); };
  const err = useAction(async () => { await load(); });
  useEffect(() => { void err.run(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [ev.id, ev.state]);
  useEffect(() => {
    if (!links) return; let alive = true; const urls: string[] = [];
    (async () => { for (const kind of ['upload', 'gallery'] as const) { try { const b = await authedBlob(`/events/${ev.id}/qr`, { kind, format: 'png', include_code: includeCode, size: 480 }); const u = URL.createObjectURL(b); urls.push(u); if (alive) setQr((p) => ({ ...p, [kind]: u })); } catch { /* shown via links error */ } } })();
    return () => { alive = false; urls.forEach(URL.revokeObjectURL); };
  }, [links?.upload_url, links?.gallery_url, includeCode, ev.id]);       // eslint-disable-line react-hooks/exhaustive-deps
  const download = useAction(async (kind: 'upload' | 'gallery', format: 'png' | 'pdf') => { const b = await authedBlob(`/events/${ev.id}/qr`, { kind, format, include_code: includeCode, size: 1600 }); const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = `${kind}-qr.${format}`; a.click(); });
  const rotate = useAction(async (type: string, passcode?: string) => { if (type !== 'passcode' && !window.confirm(`${t('host.share.rotateWarn')}`)) return; await api.post(`/events/${ev.id}/secrets/rotate`, { type, passcode, revoke_sessions: revoke }); await load(); await reload(); toast(t('common.saved')); setPass(''); });
  if (err.error) return <ErrorBox error={err.error} />;
  if (!links) return <Spinner />;
  const Row = ({ label, value, type }: { label: string; value: string | null; type?: string }) => value ? (
    <div className="stack"><div className="small muted">{label}</div><div className="row"><code style={{ wordBreak: 'break-all', flex: '1 1 260px' }}>{value}</code><CopyButton value={value} />{type && <button className="btn sm" onClick={() => rotate.run(type)}>{t('host.share.rotate')}</button>}</div></div>
  ) : null;
  return (
    <div className="stack">
      <div className="alert">{t('host.share.separate')}</div>
      <label className="check"><input type="checkbox" checked={includeCode} onChange={(e) => setIncludeCode(e.target.checked)} /><span>{t('host.share.includeCode')}</span></label>
      <label className="check"><input type="checkbox" checked={revoke} onChange={(e) => setRevoke(e.target.checked)} /><span className="small">{t('host.share.revokeSessions')}</span></label>
      <ErrorBox error={rotate.error ?? download.error} />
      <div className="grid2">
        {(['upload', 'gallery'] as const).map((k) => (
          <div key={k} className="card stack center">
            <h3>{t(k === 'upload' ? 'host.share.qrUpload' : 'host.share.qrGallery')}</h3>
            <div className="qr" style={{ margin: '0 auto' }}>{qr[k] ? <img src={qr[k]} alt={k} /> : <Spinner />}</div>
            <div className="row" style={{ justifyContent: 'center' }}>
              <button className="btn sm" onClick={() => download.run(k, 'png')}>{t('host.share.png')}</button>
              <button className="btn sm" onClick={() => download.run(k, 'pdf')}>{t('host.share.pdf')}</button>
              {typeof navigator !== 'undefined' && 'share' in navigator && <button className="btn sm" onClick={() => navigator.share({ title: ev.name, url: k === 'upload' ? links.upload_url : links.gallery_url }).catch(() => undefined)}>↗ {t('common.share')}</button>}
            </div>
          </div>
        ))}
      </div>
      <div className="card stack">
        <Row label={t('host.share.upload')} value={links.upload_url} type="upload_token" />
        <Row label={t('host.share.gallery')} value={links.gallery_url} type="gallery_token" />
        <Row label={`${t('host.share.code')} — ${t('host.share.codeScope', { scope: links.join_code_scope })}`} value={links.join_code} type="join_code" />
      </div>
      <div className="card stack">
        <h3>{t('host.share.passcode')} {links.passcode_set && <span className="badge ok">✓</span>}</h3>
        <div className="row"><input type="password" style={{ maxWidth: 280 }} value={pass} onChange={(e) => setPass(e.target.value)} minLength={4} maxLength={64} autoComplete="new-password" /><button className="btn" disabled={pass.length < 4 || rotate.pending} onClick={() => rotate.run('passcode', pass)}>{t('host.share.setPasscode')}</button></div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------- settings
function CoverCard({ ev, reload }: Props) {
  const { t } = useI18n(); const toast = useToast();
  const [file, setFile] = useState<File | null>(null);
  const save = useAction(async () => { if (!file) return; await api.putImage(`/events/${ev.id}/cover`, await prepareCover(file)); setFile(null); await reload(); toast(t('common.saved')); });
  return (
    <div className="card stack">
      <h3>{t('host.settings.cover')}</h3>
      <CoverPicker type={ev.type} current={ev.cover_url} file={file} onFile={setFile} busy={save.pending} />
      <ErrorBox error={save.error} />
      {file && <div><button className="btn primary" disabled={save.pending} onClick={() => void save.run()}>{t('host.settings.coverSave')}</button></div>}
    </div>
  );
}

export function SettingsTab({ ev, reload }: Props) {
  const { t } = useI18n(); const toast = useToast();
  const [s, setS] = useState<Record<string, any>>(ev.settings);
  const save = useAction(async () => { await api.patch(`/events/${ev.id}`, s); await reload(); toast(t('common.saved')); });
  const set = (k: string, v: any) => setS((p) => ({ ...p, [k]: v }));
  const modes = s.privacy_mode === 'public' ? ['open', 'code', 'passcode', 'verified_phone'] : ['code', 'passcode', 'verified_phone'];
  const Sw = ({ k, label, disabled }: { k: string; label: string; disabled?: boolean }) => <label className="check"><input type="checkbox" checked={!!s[k]} disabled={disabled} onChange={(e) => set(k, e.target.checked)} /><span>{label}</span></label>;
  return (
    <div className="stack">
    <CoverCard ev={ev} reload={reload} />
    <form className="card stack" onSubmit={(e) => { e.preventDefault(); void save.run(); }}>
      <Field label={t('host.new.privacy')}><select value={s.privacy_mode} onChange={(e) => set('privacy_mode', e.target.value)}><option value="private">{t('host.new.privacyPrivate')}</option><option value="public">{t('host.new.privacyPublic')}</option></select></Field>
      <div className="grid2">
        <Field label={t('host.new.uploadAccess')}><select value={s.upload_access_mode} onChange={(e) => set('upload_access_mode', e.target.value)}>{modes.map((m) => <option key={m} value={m}>{t(`host.access.${m}`)}</option>)}</select></Field>
        <Field label={t('host.settings.galleryVisibility')}><select value={s.gallery_access_mode} onChange={(e) => set('gallery_access_mode', e.target.value)}>{[...modes, 'view_only'].map((m) => <option key={m} value={m}>{t(`host.access.${m}`)}</option>)}</select></Field>
      </div>
      <Field label={t('host.share.code')}><select value={s.join_code_scope} onChange={(e) => set('join_code_scope', e.target.value)}><option value="upload">upload</option><option value="gallery">gallery</option><option value="both">both</option></select></Field>
      <Field label={t('host.settings.moderation')}><select value={s.moderation_mode} onChange={(e) => set('moderation_mode', e.target.value)}><option value="pre">{t('host.settings.moderationPre')}</option><option value="post">{t('host.settings.moderationPost')}</option></select></Field>
      <Sw k="uploads_enabled" label={t('host.settings.uploadsEnabled')} />
      <Sw k="downloads_enabled" label={t('host.settings.downloads')} />
      <Sw k="allow_original_download" label={t('host.settings.originals')} disabled={!ev.entitlement.allow_original_export} />
      <Sw k="watermark_enabled" label={t('host.settings.watermark')} disabled={!ev.entitlement.watermark} />
      <Sw k="guest_name_required" label={t('host.settings.nameRequired')} />
      <Sw k="captions_enabled" label={t('host.settings.captions')} />
      {s.captions_enabled && <Field label={t('host.settings.captionKeywords')} hint={t('host.settings.captionKeywordsHint')}><input type="text" value={(s.caption_keywords ?? []).join(', ')} onChange={(e) => set('caption_keywords', e.target.value.split(',').map((x) => x.trim()).filter(Boolean).slice(0, 50))} /></Field>}
      <Sw k="slideshow_enabled" label={t('host.settings.slideshow')} />
      <Sw k="show_uploader_names" label={t('host.settings.showNames')} />
      <Sw k="comments_enabled" label={t('host.settings.comments')} disabled />
      <Sw k="reactions_enabled" label={t('host.settings.reactions')} disabled />
      <ErrorBox error={save.error} />
      <button className="btn primary" disabled={save.pending}>{t('common.save')}</button>
    </form>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------- package / payment
interface Plan { code: string; kind: string; name: string; description: string; price_etb: number; storage_bytes: number; retention_days: number; original_storage: boolean; is_trial: boolean }
export function PaymentTab({ ev, reload }: Props) {
  const { t, lang } = useI18n();
  const [plans, setPlans] = useState<Plan[] | null>(null); const [orders, setOrders] = useState<any[]>([]);
  const refresh = async () => { const [p, o] = await Promise.all([api.get<{ plans: Plan[] }>(`/plans?lang=${lang}`), api.get<{ orders: any[] }>(`/events/${ev.id}/payments`)]); setPlans(p.plans); setOrders(o.orders); };
  useEffect(() => { void refresh(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [lang, ev.state]);
  // after returning from the gateway, poll the order: activation only happens once the provider verifies it
  const [watch, setWatch] = useState<string | null>(null); const [watchState, setWatchState] = useState<string | null>(null);
  useEffect(() => {
    const ref = new URLSearchParams(window.location.search).get('payment'); if (!ref) return;
    const o = orders.find((x) => x.order_ref === ref); if (o) setWatch(o.order_id);
  }, [orders]);
  useEffect(() => {
    if (!watch) return; let n = 0;
    const h = setInterval(async () => { n++; try { const s = await api.get<{ state: string }>(`/payments/${watch}/status`); setWatchState(s.state); if (s.state !== 'pending' || n > 40) { clearInterval(h); await reload(); await refresh(); } } catch { clearInterval(h); } }, 3000);
    return () => clearInterval(h);                       // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [watch]);
  const buy = useAction(async (code: string) => { const o = await api.post<{ checkout_url: string }>('/payments/orders', { event_id: ev.id, plan_code: code }, { 'Idempotency-Key': `order-${ev.id}-${code}-${Date.now().toString(36)}` }); window.location.href = o.checkout_url; });
  const trial = useAction(async () => { await api.post(`/events/${ev.id}/activate-trial`); await reload(); });
  if (!plans) return <Spinner />;
  const pkgs = plans.filter((p) => p.kind === 'package'); const addons = plans.filter((p) => p.kind === 'addon');
  const card = (p: Plan) => (
    <div key={p.code} className="card stack">
      <strong>{p.name}</strong><div className="small muted">{p.description}</div>
      <div style={{ fontSize: '1.4rem', fontWeight: 800 }}>{p.price_etb > 0 ? t('host.payment.price', { price: p.price_etb.toLocaleString(lang === 'am' ? 'am-ET' : 'en-ET') }) : t('host.payment.free')}</div>
      <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
        {p.storage_bytes > 0 && <li>{t('host.payment.storage', { gb: Math.round(p.storage_bytes / 1073741824 * 10) / 10 })}</li>}
        {p.retention_days > 0 && <li>{t('host.payment.retention', { days: p.retention_days })}</li>}
        {p.original_storage && <li>{t('host.payment.originals')}</li>}
      </ul>
      {p.is_trial ? (ev.state === 'draft' && <button className="btn" onClick={() => trial.run()} disabled={trial.pending}>{t('host.overview.activateTrial')}</button>) : <button className="btn primary" disabled={buy.pending} onClick={() => buy.run(p.code)}>{t('host.payment.pay')}</button>}
    </div>
  );
  return (
    <div className="stack">
      {watchState === 'pending' && <div className="alert">{t('host.payment.pending')}</div>}
      {watchState === 'paid' && <div className="alert ok">{t('host.payment.paid')}</div>}
      {watchState && ['failed', 'cancelled', 'mismatch', 'expired'].includes(watchState) && <div className="alert error">{t('host.payment.failed')}</div>}
      <ErrorBox error={buy.error ?? trial.error} />
      <h2>{t('host.payment.choose')}</h2>
      <div className="grid2">{pkgs.map(card)}</div>
      {ev.entitlement.has_package && <><h2>{t('host.payment.addons')}</h2><div className="grid2">{addons.map(card)}</div></>}
      <p className="small muted">{t('host.payment.noSilentCharges')}</p>
      {orders.length > 0 && <div className="table-wrap"><table><thead><tr><th>{t('common.date')}</th><th>ETB</th><th>{t('common.status')}</th></tr></thead><tbody>{orders.map((o) => <tr key={o.order_id}><td>{formatDate(o.created_at, lang).gregorian}</td><td>{o.amount_etb}</td><td><StateBadge state={o.state} /></td></tr>)}</tbody></table></div>}
    </div>
  );
}
