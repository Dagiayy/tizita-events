'use client';
import { useEffect, useState } from 'react';
import { api, formatBytes } from '@/lib/api';
import { formatDate } from '@/lib/ethiopian';
import { useI18n } from '@/lib/i18n';
import { ErrorBox, Field, Spinner, StateBadge, useAction, useToast } from '@/components/ui';
import type { EventDto } from './EventConsole';

// ---------------------------------------------------------------------------------------------------------------- folders
export function FoldersTab({ ev }: { ev: EventDto }) {
  const { t } = useI18n(); const toast = useToast();
  const [folders, setFolders] = useState<any[] | null>(null); const [name, setName] = useState('');
  const load = () => api.get<{ folders: any[] }>(`/events/${ev.id}/folders`).then((r) => setFolders(r.folders));
  useEffect(() => { void load(); }, [ev.id]);          // eslint-disable-line react-hooks/exhaustive-deps
  const add = useAction(async () => { await api.post(`/events/${ev.id}/folders`, { name }); setName(''); await load(); });
  const patch = useAction(async (id: string, body: any) => { await api.patch(`/folders/${id}`, body); await load(); toast(t('common.saved')); });
  const del = useAction(async (id: string) => { if (window.confirm(t('common.delete') + '?')) { await api.del(`/folders/${id}`); await load(); } });
  if (!folders) return <Spinner />;
  return (
    <div className="stack">
      <form className="row" onSubmit={(e) => { e.preventDefault(); void add.run(); }}><input type="text" placeholder={t('host.folders.name')} value={name} maxLength={80} onChange={(e) => setName(e.target.value)} style={{ maxWidth: 320 }} /><button className="btn primary" disabled={!name.trim() || add.pending}>{t('host.folders.add')}</button></form>
      <ErrorBox error={add.error ?? patch.error ?? del.error} />
      <div className="table-wrap"><table><thead><tr><th>{t('common.name')}</th><th>#</th><th>{t('common.status')}</th><th>{t('host.folders.downloads')}</th><th /></tr></thead><tbody>
        {folders.map((f) => (
          <tr key={f.id}><td>{f.name}</td><td>{f.media_count}</td>
            <td><select value={f.publication_state} onChange={(e) => patch.run(f.id, { publication_state: e.target.value })} style={{ minHeight: 36 }}><option value="published">{t('host.folders.published')}</option><option value="draft">{t('host.folders.draft')}</option></select></td>
            <td><input type="checkbox" checked={f.download_allowed} onChange={(e) => patch.run(f.id, { download_allowed: e.target.checked })} /></td>
            <td>{ev.role === 'owner' && <button className="btn sm ghost" onClick={() => del.run(f.id)}>✕</button>}</td></tr>
        ))}
      </tbody></table></div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------- team
export function TeamTab({ ev }: { ev: EventDto }) {
  const { t } = useI18n();
  const [members, setMembers] = useState<any[] | null>(null); const [phone, setPhone] = useState(''); const [role, setRole] = useState<'moderator' | 'photographer'>('moderator');
  const load = () => api.get<{ members: any[] }>(`/events/${ev.id}/members`).then((r) => setMembers(r.members));
  useEffect(() => { void load(); }, [ev.id]);           // eslint-disable-line react-hooks/exhaustive-deps
  const invite = useAction(async () => { const r = await api.post<{ members: any[] }>(`/events/${ev.id}/members`, { phone, role }); setMembers(r.members); setPhone(''); });
  const remove = useAction(async (id: string) => { await api.del(`/events/${ev.id}/members/${id}`); await load(); });
  if (!members) return <Spinner />;
  return (
    <div className="stack">
      <form className="card row" onSubmit={(e) => { e.preventDefault(); void invite.run(); }}>
        <input type="tel" placeholder="09…" value={phone} onChange={(e) => setPhone(e.target.value)} style={{ maxWidth: 220 }} aria-label={t('host.team.invite')} />
        <select value={role} onChange={(e) => setRole(e.target.value as any)} style={{ width: 'auto' }}><option value="moderator">{t('host.team.moderator')}</option><option value="photographer">{t('host.team.photographer')}</option></select>
        <button className="btn primary" disabled={phone.length < 9 || invite.pending}>{t('host.team.invite')}</button>
      </form>
      <p className="small muted">{ev.entitlement.max_collaborators} · {ev.entitlement.photographer_seats} {t('host.team.photographer')}</p>
      <ErrorBox error={invite.error ?? remove.error} />
      <div className="table-wrap"><table><tbody>{members.map((m) => (
        <tr key={m.id}><td>{m.display_name ?? (m.phone_last4 ? `••• ${m.phone_last4}` : '…')}</td><td>{t(`host.team.${m.role}`)}</td><td><StateBadge state={m.status === 'active' ? 'ok' : 'pending'} label={t(`host.team.${m.status}`)} /></td><td>{m.role !== 'owner' && <button className="btn sm ghost" onClick={() => remove.run(m.id)}>{t('host.team.remove')}</button>}</td></tr>
      ))}</tbody></table></div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------- exports
export function ExportsTab({ ev }: { ev: EventDto }) {
  const { t, lang } = useI18n();
  const [list, setList] = useState<any[] | null>(null); const [scope, setScope] = useState<'full' | 'folder'>('full'); const [folder, setFolder] = useState(''); const [variant, setVariant] = useState<'optimized' | 'original'>('optimized');
  const [folders, setFolders] = useState<any[]>([]);
  const load = () => api.get<{ exports: any[] }>(`/events/${ev.id}/exports`).then((r) => setList(r.exports));
  useEffect(() => { void load(); api.get<{ folders: any[] }>(`/events/${ev.id}/folders`).then((r) => setFolders(r.folders)); }, [ev.id]);   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (!list?.some((x) => ['queued', 'processing'].includes(x.state))) return; const h = setInterval(load, 2500); return () => clearInterval(h); }, [list]);   // eslint-disable-line react-hooks/exhaustive-deps
  const create = useAction(async () => { await api.post(`/events/${ev.id}/exports`, { scope, folder_id: scope === 'folder' ? folder : undefined, variant }, { 'Idempotency-Key': `exp-${ev.id}-${Date.now().toString(36)}` }); await load(); });
  const dl = useAction(async (id: string) => { const r = await api.get<{ url: string }>(`/exports/${id}/download`); window.location.href = r.url; });
  if (!list) return <Spinner />;
  return (
    <div className="stack">
      <div className="card stack">
        <div className="grid2">
          <Field label={t('host.exports.scope')}><select value={scope} onChange={(e) => setScope(e.target.value as any)}><option value="full">{t('host.exports.full')}</option><option value="folder">{t('host.exports.folder')}</option></select></Field>
          {scope === 'folder' && <Field label={t('host.tab.folders')}><select value={folder} onChange={(e) => setFolder(e.target.value)}><option value="">—</option>{folders.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}</select></Field>}
          <Field label={t('host.exports.quality')}><select value={variant} onChange={(e) => setVariant(e.target.value as any)}><option value="optimized">{t('host.exports.optimized')}</option><option value="original" disabled={!ev.entitlement.allow_original_export}>{t('host.exports.original')}</option></select></Field>
        </div>
        <ErrorBox error={create.error ?? dl.error} />
        <button className="btn primary" disabled={create.pending || (scope === 'folder' && !folder)} onClick={() => create.run()}>{t('host.exports.create')}</button>
        <p className="small muted">{t('host.exports.expires')}</p>
      </div>
      <div className="table-wrap"><table><thead><tr><th>{t('common.created')}</th><th>#</th><th>{t('host.exports.quality')}</th><th>{t('common.status')}</th><th /></tr></thead><tbody>
        {list.map((x) => <tr key={x.id}><td>{formatDate(x.created_at, lang, { time: true }).gregorian}</td><td>{x.item_count ?? '…'}{x.bytes ? ` · ${formatBytes(x.bytes)}` : ''}</td><td>{x.variant}</td><td><StateBadge state={x.state} label={t(`host.exports.${x.state}`)} /></td><td>{x.state === 'ready' && <button className="btn sm primary" onClick={() => dl.run(x.id)}>⬇ {t('host.exports.download')}</button>}</td></tr>)}
      </tbody></table></div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------- insights
export function InsightsTab({ ev }: { ev: EventDto }) {
  const { t, lang } = useI18n();
  const [i, setI] = useState<any>(null);
  useEffect(() => { api.get(`/events/${ev.id}/insights`).then(setI); }, [ev.id]);
  if (!i) return <Spinner />;
  const stat = (v: string | number, label: string) => <div className="stat"><b>{v}</b><span>{label}</span></div>;
  const steps = ['landing_view', 'join', 'capture_select', 'upload_intent', 'upload_complete', 'approved', 'gallery_view', 'download', 'share'];
  const max = Math.max(1, ...steps.map((s) => i.funnel[s] ?? 0));
  return (
    <div className="stack">
      <div className="stats">
        {stat(i.uploads, t('host.insights.uploads'))}{stat(i.unique_contributors, t('host.insights.contributors'))}{stat(i.approvals, t('host.insights.approved'))}{stat(i.pending, t('host.insights.pending'))}{stat(i.rejected, t('host.insights.rejected'))}
        {stat(i.views, t('host.insights.views'))}{stat(i.downloads, t('host.insights.downloads'))}
        {stat(i.peak_upload_hour_eat ? formatDate(i.peak_upload_hour_eat, lang, { time: true }).gregorian.split(' ').slice(-1)[0] : '—', t('host.insights.peak'))}
        {stat(`${formatBytes(i.storage.used_bytes)} (${i.storage.percent}%)`, t('host.insights.storage'))}
      </div>
      <div className="card stack"><h3>{t('host.insights.funnel')}</h3>
        {steps.map((s) => <div key={s}><div className="row between small"><span>{s.replace(/_/g, ' ')}</span><strong>{i.funnel[s] ?? 0}</strong></div><div className="progress"><i style={{ width: `${((i.funnel[s] ?? 0) / max) * 100}%` }} /></div></div>)}
      </div>
    </div>
  );
}
