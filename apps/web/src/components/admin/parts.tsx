'use client';
import { useEffect, useState, type ReactNode } from 'react';
import { api, flags } from '@/lib/api';
import { formatDate } from '@/lib/ethiopian';
import { useI18n } from '@/lib/i18n';
import { ErrorBox, Spinner, StateBadge } from '@/components/ui';

export function useFetch<T = any>(path: string | null, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null); const [error, setError] = useState<unknown>(null); const [n, setN] = useState(0);
  useEffect(() => { if (!path) return; let alive = true; setData(null); api.get<T>(path).then((d) => alive && setData(d)).catch((e) => alive && setError(e)); return () => { alive = false; }; /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [path, n, ...deps]);
  return { data, error, reload: () => setN((x) => x + 1) };
}

export type Col<R> = { key: string; label: string; render?: (r: R) => ReactNode };
const fmt = (v: unknown, lang: 'en' | 'am'): ReactNode => {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'boolean') return v ? '✓' : '✗';
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v)) return <span className="nowrap">{formatDate(v, lang, { time: true }).gregorian}</span>;
  if (typeof v === 'object') return <code className="small">{JSON.stringify(v).slice(0, 120)}</code>;
  return String(v);
};

export function DataTable<R extends Record<string, any>>({ rows, cols, empty, onRow }: { rows: R[] | null | undefined; cols: Col<R>[]; empty?: string; onRow?: (r: R) => void }) {
  const { lang, t } = useI18n();
  if (!rows) return <Spinner />;
  if (!rows.length) return <div className="card center muted">{empty ?? t('common.noData')}</div>;
  return (
    <div className="table-wrap"><table><thead><tr>{cols.map((c) => <th key={c.key}>{c.label}</th>)}</tr></thead>
      <tbody>{rows.map((r, i) => <tr key={r.id ?? r.seq ?? i} onClick={onRow ? () => onRow(r) : undefined} style={onRow ? { cursor: 'pointer' } : undefined}>{cols.map((c) => <td key={c.key}>{c.render ? c.render(r) : c.key.endsWith('state') || c.key === 'status' ? <StateBadge state={String(r[c.key])} /> : fmt(r[c.key], lang)}</td>)}</tr>)}</tbody></table></div>
  );
}

export function Section({ title, children, error }: { title: string; children: ReactNode; error?: unknown }) {
  return <section className="stack"><h2>{title}</h2><ErrorBox error={error} />{children}</section>;
}

/** Fresh authenticator code for high-risk actions (suspend, refunds, legal hold, settings...). */
export function StepUp({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const { t } = useI18n();
  if (!flags.adminMfa) return null;
  return <label className="field" style={{ maxWidth: 220 }}><span>{t('common.authCode')}</span><input type="text" inputMode="numeric" autoComplete="one-time-code" value={value} onChange={(e) => onChange(e.target.value.replace(/\D/g, '').slice(0, 6))} /></label>;
}

export const Stat = ({ v, label, tone }: { v: ReactNode; label: string; tone?: 'bad' | 'warn' }) => <div className="stat"><b style={tone ? { color: `var(--${tone === 'bad' ? 'danger' : 'warn'})` } : undefined}>{v}</b><span>{label}</span></div>;
