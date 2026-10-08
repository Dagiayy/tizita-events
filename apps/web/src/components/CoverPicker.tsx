'use client';
import { useEffect, useRef, useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { sampleCover } from '@/lib/samples';

/** Cover photo chooser. Shows the picked photo, else the event's current cover, else the sample for the event type. */
export function CoverPicker({ type, current, file, onFile, busy }: { type: string; current?: string | null; file: File | null; onFile: (f: File | null) => void; busy?: boolean }) {
  const { t } = useI18n();
  const input = useRef<HTMLInputElement>(null);
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => { if (!file) { setUrl(null); return; } const u = URL.createObjectURL(file); setUrl(u); return () => URL.revokeObjectURL(u); }, [file]);
  const shown = url || current || sampleCover(type);
  const isSample = !url && !current;
  return (
    <div className="cover-picker">
      <div className="cover-preview" style={{ backgroundImage: `url(${shown})` }}>
        <span className="badge">{isSample ? t('host.new.coverSample', { type: t(`host.type.${type}`) }) : t('host.new.cover')}</span>
      </div>
      <div className="stack">
        <p className="small muted" style={{ margin: 0 }}>{t('host.new.coverHint')}</p>
        <div className="row">
          <input ref={input} type="file" accept="image/jpeg,image/png,image/webp" hidden onChange={(e) => { const f = e.target.files?.[0] ?? null; e.target.value = ''; if (f) onFile(f); }} />
          <button type="button" className="btn sm" disabled={busy} onClick={() => input.current?.click()}>{t('host.new.coverChoose')}</button>
          {file && <button type="button" className="btn sm ghost" disabled={busy} onClick={() => onFile(null)}>{t('host.new.coverRemove')}</button>}
        </div>
      </div>
    </div>
  );
}
