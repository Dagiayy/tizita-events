'use client';
import { useEffect, useState } from 'react';
import { request } from '@/lib/api';
import { LangSwitch, useI18n } from '@/lib/i18n';
import { ErrorBox, Field, Spinner, Topbar, useAction } from '@/components/ui';
import { formatDate } from '@/lib/ethiopian';

const TYPES = ['removal', 'access', 'erasure', 'objection', 'restriction', 'consent_withdrawal'] as const;

/** Rights-request intake + status (spec 9.2, 13): works without an account; the one-time key lets the requester check progress. */
export default function Privacy() {
  const { t, lang } = useI18n();
  const [type, setType] = useState<(typeof TYPES)[number]>('removal');
  const [locator, setLocator] = useState(''); const [details, setDetails] = useState(''); const [contact, setContact] = useState('');
  const [done, setDone] = useState<{ ref: string; access_token: string; due_at: string } | null>(null);
  const [chk, setChk] = useState({ ref: '', token: '' }); const [status, setStatus] = useState<any>(null);
  const [policy, setPolicy] = useState<{ title: string; body: string; legal_status: string } | null>(null);
  useEffect(() => { request(`/policies/privacy_policy?lang=${lang}`).then(setPolicy).catch(() => setPolicy(null)); }, [lang]);
  const guestToken = typeof window !== 'undefined' ? (() => { try { const k = Object.keys(localStorage).find((x) => x.startsWith('ep.guest.')); return k ? JSON.parse(localStorage.getItem(k)!).token as string : null; } catch { return null; } })() : null;
  const submit = useAction(async () => {
    const m = /\/j\/([A-Za-z0-9_-]+)/.exec(locator); const loc = (m ? m[1] : locator).trim();
    const r = await request<{ ref: string; access_token: string; due_at: string }>('/privacy/requests', { method: 'POST', token: guestToken, json: { type, requester_kind: 'other', event_locator: loc || undefined, details: details || undefined, contact: contact || undefined } });
    setDone(r);
  });
  const check = useAction(async () => setStatus(await request(`/privacy/requests/${encodeURIComponent(chk.ref.trim())}`, { headers: { 'X-Request-Token': chk.token.trim() } })));
  return (
    <>
      <Topbar title={t('app.name')} right={<LangSwitch />} />
      <main className="narrow stack" style={{ paddingTop: 24, paddingBottom: 48 }}>
        <h1>{t('privacy.title')}</h1>
        <p className="muted">{t('privacy.intro')}</p>
        {done ? (
          <div className="card stack">
            <h2>{t('privacy.received')}</h2>
            <p>{t('privacy.reference')}: <strong>{done.ref}</strong></p>
            <p>{t('privacy.token')}: <code style={{ wordBreak: 'break-all' }}>{done.access_token}</code></p>
            <p className="small muted">{t('privacy.due')}: {formatDate(done.due_at, lang).gregorian}</p>
          </div>
        ) : (
          <form className="card stack" onSubmit={(e) => { e.preventDefault(); void submit.run(); }}>
            <Field label={t('privacy.type')}><select value={type} onChange={(e) => setType(e.target.value as any)}>{TYPES.map((x) => <option key={x} value={x}>{t(`privacy.type.${x}`)}</option>)}</select></Field>
            <Field label={t('privacy.eventCode')}><input type="text" value={locator} onChange={(e) => setLocator(e.target.value)} /></Field>
            <Field label={t('privacy.details')}><textarea value={details} maxLength={2000} onChange={(e) => setDetails(e.target.value)} /></Field>
            <Field label={t('privacy.contact')}><input type="text" value={contact} maxLength={120} onChange={(e) => setContact(e.target.value)} /></Field>
            <ErrorBox error={submit.error} />
            <button className="btn primary" disabled={submit.pending}>{t('privacy.send')}</button>
          </form>
        )}
        <form className="card stack" onSubmit={(e) => { e.preventDefault(); void check.run(); }}>
          <h2>{t('privacy.check')}</h2>
          <Field label={t('privacy.reference')}><input type="text" value={chk.ref} onChange={(e) => setChk({ ...chk, ref: e.target.value })} /></Field>
          <Field label={t('privacy.token')}><input type="password" value={chk.token} onChange={(e) => setChk({ ...chk, token: e.target.value })} /></Field>
          <ErrorBox error={check.error} />
          <button className="btn" disabled={check.pending}>{t('privacy.check')}</button>
          {status && <div className="alert ok"><strong>{t('privacy.status')}:</strong> {status.state} · {t('privacy.due')}: {formatDate(status.due_at, lang).gregorian}</div>}
        </form>
        {policy ? <details className="card"><summary>{policy.title}</summary><p>{policy.body}</p>{policy.legal_status !== 'approved' && <p className="small muted">{t('guest.notice.draft')}</p>}</details> : <Spinner />}
      </main>
    </>
  );
}
