'use client';
import { useEffect, useState, type ReactNode } from 'react';
import { ApiError, api, flags, logout, onAuthChange, refreshSession, request, setAccessToken } from '@/lib/api';
import { LangSwitch, useI18n } from '@/lib/i18n';
import { ErrorBox, Field, Icon, Spinner, ToastProvider, Topbar, useAction } from '@/components/ui';

/** +251 OTP sign-in for hosts and staff; staff additionally complete authenticator-app 2FA (admin 2FA is mandatory). */
export function AuthGate({ staff = false, title, nav, menu, children }: { staff?: boolean; title: string; nav?: ReactNode; menu?: ReactNode; children: ReactNode }) {
  const { t } = useI18n();
  const [state, setState] = useState<'loading' | 'out' | 'mfa' | 'in' | 'denied'>('loading');
  const evaluate = async () => {
    if (!(await refreshSession())) { setState('out'); return; }
    if (!staff) { setState('in'); return; }
    try {
      const s = await api.get<{ sessions: { current: boolean; mfa_verified: boolean }[] }>('/sessions');
      const me = s.sessions.find((x) => x.current);
      await api.get<{ admin_mfa_required?: boolean }>('/admin/dashboard').then((d) => { flags.adminMfa = d.admin_mfa_required !== false; setState('in'); }).catch((e) => setState(e instanceof ApiError && e.code === 'mfa_required' ? 'mfa' : e instanceof ApiError && e.code === 'staff_only' ? 'denied' : me?.mfa_verified ? 'in' : 'mfa'));
    } catch { setState('out'); }
  };
  useEffect(() => { void evaluate(); const un = onAuthChange((s) => { if (!s) setState('out'); }); return un; /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);
  if (state === 'loading') return <Spinner />;
  if (state === 'out') return <Wrap title={title}><Login onDone={evaluate} /></Wrap>;
  if (state === 'mfa') return <Wrap title={title}><Mfa onDone={evaluate} /></Wrap>;
  if (state === 'denied') return <Wrap title={title}><div className="alert error">{t('err.mfa_required').replace(/.*/, 'This account is not a platform staff account.')}</div><button className="btn" onClick={() => logout()}>{t('common.signOut')}</button></Wrap>;
  return (
    <ToastProvider>
      <Topbar rail title={title} href={staff ? '/admin' : '/host'} menu={menu} right={<><LangSwitch />{nav}<button className="btn sm icon" onClick={() => logout()} aria-label={t('common.signOut')} title={t('common.signOut')}><Icon name="logout" /><span className="label">{t('common.signOut')}</span></button></>} />
      <div className="with-rail">{children}</div>
    </ToastProvider>
  );
}

function Wrap({ title, children }: { title: string; children: ReactNode }) {
  return <ToastProvider><Topbar title={title} right={<LangSwitch />} /><main className="narrow stack auth-wrap">{children}</main></ToastProvider>;
}

function Login({ onDone }: { onDone: () => void }) {
  const { t, lang } = useI18n();
  const [phone, setPhone] = useState(''); const [code, setCode] = useState(''); const [sent, setSent] = useState(false); const [recovery, setRecovery] = useState(false);
  const send = useAction(async () => { await request('/auth/request-otp', { method: 'POST', json: { phone, locale: lang } }); setSent(true); });
  const verify = useAction(async () => {
    const r = await request<{ access_token: string }>('/auth/verify-otp', { method: 'POST', web: true, json: { phone, code, recovery, device_label: navigator.userAgent.slice(0, 60) } });
    setAccessToken(r.access_token); onDone();
  });
  return (
    <form className="card stack" onSubmit={(e) => { e.preventDefault(); void (sent ? verify.run() : send.run()); }}>
      <h1>{t('host.login.title')}</h1>
      <Field label={t('host.login.phone')} hint={t('host.login.phoneHint')}><input type="tel" inputMode="tel" autoComplete="tel" value={phone} onChange={(e) => setPhone(e.target.value)} disabled={sent} /></Field>
      {sent && <><p className="small muted">{t('host.login.sentTo', { phone })}</p><Field label={t('host.login.code')}><input type="text" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 8))} autoFocus /></Field>
        <label className="check"><input type="checkbox" checked={recovery} onChange={(e) => setRecovery(e.target.checked)} /><span className="small">{t('host.login.recovery')}</span></label></>}
      <ErrorBox error={send.error ?? verify.error} />
      <button className="btn primary big" disabled={send.pending || verify.pending || (sent ? code.length < 4 : phone.length < 9)}>{sent ? t('host.login.verify') : t('host.login.send')}</button>
      {sent && <button type="button" className="btn ghost" onClick={() => { setSent(false); setCode(''); }}>{t('host.login.changeNumber')}</button>}
      <p className="small muted">{t('host.login.help')}</p>
    </form>
  );
}

function Mfa({ onDone }: { onDone: () => void }) {
  const { t } = useI18n();
  const [enroll, setEnroll] = useState<{ secret: string; otpauth_uri: string } | null>(null); const [code, setCode] = useState('');
  useEffect(() => { api.post<{ secret: string; otpauth_uri: string }>('/auth/2fa/enroll').then(setEnroll).catch(() => setEnroll(null)); }, []);   // 409 when already enrolled -> just ask for a code
  const verify = useAction(async () => { const r = await api.post<{ access_token: string }>('/auth/2fa/verify', { code }); setAccessToken(r.access_token); onDone(); });
  return (
    <form className="card stack" onSubmit={(e) => { e.preventDefault(); void verify.run(); }}>
      <h1>{t('admin.mfa.title')}</h1>
      <p className="muted">{enroll ? t('admin.mfa.enroll') : t('admin.mfa.enter')}</p>
      {enroll && <div className="alert"><div className="small">Secret (manual entry)</div><code style={{ wordBreak: 'break-all', fontSize: '1.05rem' }}>{enroll.secret}</code><div className="small" style={{ marginTop: 6 }}><a href={enroll.otpauth_uri}>otpauth link</a></div></div>}
      <Field label={t('common.authCode')}><input type="text" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))} autoFocus /></Field>
      <ErrorBox error={verify.error} />
      <button className="btn primary big" disabled={code.length !== 6 || verify.pending}>{t('admin.mfa.verify')}</button>
    </form>
  );
}
