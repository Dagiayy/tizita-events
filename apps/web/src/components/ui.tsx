'use client';
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { ApiError } from '@/lib/api';
import { errorMessage, useI18n } from '@/lib/i18n';

export function Spinner({ label }: { label?: string }) {
  const { t } = useI18n();
  return <p className="muted center dots" role="status"><i /><i /><i /><span className="sr-only">{label ?? t('common.loading')}</span></p>;
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return <label className="field"><span>{label}</span>{children}{hint && <small>{hint}</small>}</label>;
}

export function ErrorBox({ error }: { error: unknown }) {
  const { t } = useI18n();
  if (!error) return null;
  const code = error instanceof ApiError ? (error.isNetwork ? 'network' : error.code) : undefined;
  const msg = code === 'network' ? t('err.network') : errorMessage(t, code);
  return <div className="alert error" role="alert">{msg}</div>;
}

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const { t } = useI18n();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); prev?.focus(); };
  }, [onClose]);
  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} ref={ref} onClick={(e) => e.stopPropagation()}>
        <div className="row between"><h2>{title}</h2><button className="btn ghost sm" onClick={onClose} aria-label={t('common.close')}>✕</button></div>
        {children}
      </div>
    </div>
  );
}

const ToastCtx = createContext<(m: string) => void>(() => undefined);
export const useToast = () => useContext(ToastCtx);
export function ToastProvider({ children }: { children: ReactNode }) {
  const [msg, setMsg] = useState<string | null>(null);
  const show = useCallback((m: string) => { setMsg(m); setTimeout(() => setMsg(null), 2600); }, []);
  return <ToastCtx.Provider value={show}>{children}{msg && <div className="toast" role="status">{msg}</div>}</ToastCtx.Provider>;
}

export function CopyButton({ value, label }: { value: string; label?: string }) {
  const { t } = useI18n(); const toast = useToast();
  return <button className="btn sm" onClick={async () => { try { await navigator.clipboard.writeText(value); toast(t('common.copied')); } catch { window.prompt(t('common.copy'), value); } }}>{label ?? t('common.copy')}</button>;
}

const STATE_TONE: Record<string, string> = { live: 'ok', scheduled: 'info', draft: '', closing: 'warn', read_only: 'info', archived: '', deletion_pending: 'bad', deleted: 'bad', suspended: 'bad', approved: 'ok', pending: 'warn', rejected: 'bad', flagged: 'bad', hidden: 'warn', paid: 'ok', failed: 'bad', ready: 'ok' };
export function StateBadge({ state, label }: { state: string; label?: string }) {
  return <span className={`badge ${STATE_TONE[state] ?? ''}`}>{label ?? state}</span>;
}

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: { id: T; label: string }[]; value: T; onChange: (t: T) => void }) {
  return <div className="tabs" role="tablist">{tabs.map((x) => <button key={x.id} role="tab" aria-selected={value === x.id} className={value === x.id ? 'on' : ''} onClick={() => onChange(x.id)}>{x.label}</button>)}</div>;
}

/** Runs an async action with pending + error state. */
export function useAction<A extends unknown[], R>(fn: (...a: A) => Promise<R>) {
  const [pending, setPending] = useState(false); const [error, setError] = useState<unknown>(null);
  const run = useCallback(async (...a: A): Promise<R | undefined> => {
    setPending(true); setError(null);
    try { return await fn(...a); } catch (e) { setError(e); return undefined; } finally { setPending(false); }
  }, [fn]);
  return { run, pending, error, clear: () => setError(null) };
}

/** Top bar; `rail` turns it into the dark navy sidebar on desktop (signed-in console screens). `menu` is the sidebar navigation. */
export function Topbar({ title, href = '/', right, rail = false, menu }: { title: string; href?: string; right?: ReactNode; rail?: boolean; menu?: ReactNode }) {
  return <header className={`topbar${rail ? ' rail' : ''}`}><a className="brand" href={href} aria-label={title}>{title}</a>{menu && <nav className="rail-menu" aria-label="main">{menu}</nav>}<span className="grow" />{right}</header>;
}

/** Shimmering placeholder wall shown while the first page of photos loads. */
export function SkeletonWall({ n = 8 }: { n?: number }) {
  const hs = [220, 150, 190, 260, 170, 230, 140, 200];
  return <div className="masonry pin skeleton" aria-hidden>{Array.from({ length: n }, (_, i) => <i key={i} className="tile sk" style={{ height: hs[i % hs.length] }} />)}</div>;
}

export type IconName = 'logout' | 'settings' | 'dashboard' | 'events' | 'orgs' | 'payments' | 'storage' | 'moderation' | 'access' | 'compliance' | 'audit' | 'config' | 'account';

const PATHS: Record<IconName, ReactNode> = {
  logout: <><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><path d="M16 17l5-5-5-5" /><path d="M21 12H9" /></>,
  settings: <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3h0a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5h0a1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8v0a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" /></>,
  dashboard: <><rect x="3" y="3" width="7" height="9" rx="2" /><rect x="14" y="3" width="7" height="5" rx="2" /><rect x="14" y="12" width="7" height="9" rx="2" /><rect x="3" y="16" width="7" height="5" rx="2" /></>,
  events: <><rect x="3" y="5" width="18" height="16" rx="3" /><path d="M16 3v4M8 3v4M3 10h18" /></>,
  orgs: <><path d="M3 21h18" /><path d="M5 21V7l7-4 7 4v14" /><path d="M9 21v-6h6v6" /></>,
  payments: <><rect x="2" y="5" width="20" height="14" rx="3" /><path d="M2 10h20" /><path d="M6 15h4" /></>,
  storage: <><ellipse cx="12" cy="5" rx="8" ry="3" /><path d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5" /><path d="M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6" /></>,
  moderation: <><path d="M12 3l8 3v6c0 5-3.4 8-8 9-4.6-1-8-4-8-9V6z" /><path d="M9 12l2 2 4-4" /></>,
  access: <><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20c.5-3.5 3-5.5 6.5-5.5s6 2 6.5 5.5" /><path d="M17 11a3 3 0 1 0 0-6M21.5 20c-.3-2.4-1.5-4.1-3.5-5" /></>,
  compliance: <><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5" /><path d="M9 14l2 2 4-4" /></>,
  audit: <><circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" /><path d="M8 11h6M11 8v6" /></>,
  config: <><path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0" /><circle cx="16" cy="6" r="2" /><circle cx="10" cy="12" r="2" /><circle cx="18" cy="18" r="2" /></>,
  account: <><circle cx="12" cy="8" r="4" /><path d="M4 21c.6-4 3.6-6 8-6s7.4 2 8 6" /></>,
};

/** Small inline icons (no icon font / CDN needed). */
export function Icon({ name, size = 22 }: { name: IconName; size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>{PATHS[name]}</svg>;
}
