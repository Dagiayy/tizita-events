'use client';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { formatDate } from '@/lib/ethiopian';
import { useI18n } from '@/lib/i18n';
import { ErrorBox, Field, Spinner, useAction } from '@/components/ui';

export default function Account() {
  const { t, lang } = useI18n();
  const [sessions, setSessions] = useState<any[] | null>(null); const [subject, setSubject] = useState(''); const [body, setBody] = useState(''); const [ref, setRef] = useState<string | null>(null);
  const load = () => api.get<{ sessions: any[] }>('/sessions').then((r) => setSessions(r.sessions));
  useEffect(() => { void load(); }, []);
  const revoke = useAction(async (id: string) => { await api.del(`/sessions/${id}`); await load(); });
  const others = useAction(async () => { await api.post('/sessions/revoke-others'); await load(); });
  const send = useAction(async () => { const r = await api.post<{ ref: string }>('/support/tickets', { subject, body, category: 'general' }); setRef(r.ref); setSubject(''); setBody(''); });
  if (!sessions) return <Spinner />;
  return (
    <main className="narrow stack" style={{ paddingTop: 20, paddingBottom: 40 }}>
      <h1>{t('host.account.sessions')}</h1>
      <ErrorBox error={revoke.error ?? others.error} />
      <div className="stack">{sessions.map((s) => (
        <div key={s.id} className="card row between"><div><strong>{s.device_label || 'device'}</strong> {s.current && <span className="badge ok">{t('host.account.current')}</span>}<div className="small muted">{formatDate(s.last_used_at, lang, { time: true }).gregorian} · {s.ip}</div></div>{!s.current && <button className="btn sm" onClick={() => revoke.run(s.id)}>{t('host.account.revoke')}</button>}</div>
      ))}</div>
      {sessions.length > 1 && <button className="btn" onClick={() => others.run()}>{t('host.account.revokeOthers')}</button>}
      <h2 style={{ marginTop: 24 }}>{t('host.account.support')}</h2>
      <form className="card stack" onSubmit={(e) => { e.preventDefault(); void send.run(); }}>
        <Field label={t('host.support.subject')}><input type="text" value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={160} /></Field>
        <Field label={t('host.support.body')}><textarea value={body} onChange={(e) => setBody(e.target.value)} maxLength={4000} /></Field>
        <ErrorBox error={send.error} />
        {ref && <div className="alert ok">{t('host.support.sent', { ref })}</div>}
        <button className="btn primary" disabled={subject.length < 3 || body.length < 5 || send.pending}>{t('host.support.send')}</button>
      </form>
    </main>
  );
}
