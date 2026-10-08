'use client';
import { useState } from 'react';
import { api } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { DateTimeEntry } from '@/components/DateTimeEntry';
import { ErrorBox, Field, useAction } from '@/components/ui';
import { CoverPicker } from '@/components/CoverPicker';
import { prepareCover } from '@/lib/cover';

const TYPES = ['wedding', 'birthday', 'graduation', 'conference', 'corporate', 'party', 'family', 'cultural', 'other'] as const;

export default function NewEvent() {
  const { t, lang } = useI18n();
  const soon = () => { const d = new Date(Date.now() + 7 * 86400_000); d.setUTCMinutes(0, 0, 0); return d; };
  const [f, setF] = useState({ name: '', type: 'wedding', city: 'Addis Ababa', venue: '', host_name: '', language: lang as 'en' | 'am', privacy_mode: 'private', upload_access_mode: 'code', gallery_access_mode: 'code', moderation_mode: 'pre' });
  const [start, setStart] = useState(soon); const [end, setEnd] = useState(() => new Date(soon().getTime() + 6 * 3600_000));
  const [cover, setCover] = useState<File | null>(null);
  const set = (k: string, v: string) => setF((p) => ({ ...p, [k]: v }));
  const create = useAction(async () => {
    const e = await api.post<{ id: string }>('/events', {
      ...f, venue: f.venue || undefined, host_name: f.host_name || undefined, starts_at: start.toISOString(), ends_at: end.toISOString(),
      upload_opens_at: start.toISOString(), upload_closes_at: new Date(end.getTime() + 12 * 3600_000).toISOString(),
    });
    if (cover) { try { await api.putImage(`/events/${e.id}/cover`, await prepareCover(cover)); } catch { /* the event exists; the cover can be set again under Settings */ } }
    window.location.href = `/host/events/${e.id}`;
  });
  const modes = f.privacy_mode === 'public' ? ['open', 'code', 'passcode', 'verified_phone'] : ['code', 'passcode', 'verified_phone'];
  return (
    <main className="narrow stack" style={{ paddingTop: 20, paddingBottom: 48 }}>
      <h1>{t('host.new.title')}</h1>
      <form className="card stack" onSubmit={(e) => { e.preventDefault(); void create.run(); }}>
        <Field label={t('host.new.name')}><input type="text" required maxLength={120} value={f.name} onChange={(e) => set('name', e.target.value)} lang={lang} /></Field>
        <Field label={t('host.new.type')}><select value={f.type} onChange={(e) => set('type', e.target.value)}>{TYPES.map((x) => <option key={x} value={x}>{t(`host.type.${x}`)}</option>)}</select></Field>
        <Field label={t('host.new.cover')}><CoverPicker type={f.type} file={cover} onFile={setCover} busy={create.pending} /></Field>
        <DateTimeEntry label={t('host.new.start')} value={start} onChange={(d) => { setStart(d); if (d >= end) setEnd(new Date(d.getTime() + 6 * 3600_000)); }} />
        <DateTimeEntry label={t('host.new.end')} value={end} onChange={setEnd} />
        <p className="small muted">{t('host.new.timezone')} · {t('host.new.country')}</p>
        <div className="grid2">
          <Field label={t('host.new.city')}><input type="text" required maxLength={80} value={f.city} onChange={(e) => set('city', e.target.value)} /></Field>
          <Field label={t('host.new.venue')}><input type="text" maxLength={160} value={f.venue} onChange={(e) => set('venue', e.target.value)} /></Field>
        </div>
        <Field label={t('host.new.hostName')}><input type="text" maxLength={120} value={f.host_name} onChange={(e) => set('host_name', e.target.value)} /></Field>
        <Field label={t('host.new.language')}><select value={f.language} onChange={(e) => set('language', e.target.value)}><option value="en">English</option><option value="am">አማርኛ</option></select></Field>
        <Field label={t('host.new.privacy')}><select value={f.privacy_mode} onChange={(e) => { const v = e.target.value; setF((p) => ({ ...p, privacy_mode: v, upload_access_mode: v === 'private' && p.upload_access_mode === 'open' ? 'code' : p.upload_access_mode, gallery_access_mode: v === 'private' && p.gallery_access_mode === 'open' ? 'code' : p.gallery_access_mode })); }}><option value="private">{t('host.new.privacyPrivate')}</option><option value="public">{t('host.new.privacyPublic')}</option></select></Field>
        <div className="grid2">
          <Field label={t('host.new.uploadAccess')}><select value={f.upload_access_mode} onChange={(e) => set('upload_access_mode', e.target.value)}>{modes.map((m) => <option key={m} value={m}>{t(`host.access.${m}`)}</option>)}</select></Field>
          <Field label={t('host.new.galleryAccess')}><select value={f.gallery_access_mode} onChange={(e) => set('gallery_access_mode', e.target.value)}>{[...modes.filter((m) => m !== 'passcode' || true), 'view_only'].map((m) => <option key={m} value={m}>{t(`host.access.${m}`)}</option>)}</select></Field>
        </div>
        {(f.upload_access_mode === 'passcode' || f.gallery_access_mode === 'passcode') && <div className="alert warn small">Set the passcode in Share after creating the event; until then use “join code”.</div>}
        <label className="check"><input type="checkbox" checked={f.moderation_mode === 'pre'} onChange={(e) => set('moderation_mode', e.target.checked ? 'pre' : 'post')} /><span>{t('host.new.moderation')}</span></label>
        <ErrorBox error={create.error} />
        <button className="btn primary big" disabled={create.pending || !f.name.trim()}>{t('host.new.create')}</button>
      </form>
    </main>
  );
}
