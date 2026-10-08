'use client';
import { useEffect, useMemo, useState } from 'react';
import { formatBytes } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { estimateBytes, type QueueItem } from '@/lib/upload-queue';

/** Preview step: thumbnails, estimated upload size, data saver, optional caption, then upload. */
export function UploadPanel(p: {
  files: File[]; items: QueueItem[]; captionsEnabled: boolean; captionMax: number; maxBytes: number; dataSaver: boolean;
  onDataSaver: (v: boolean) => void; onCancel: () => void; onRemove: (i: number) => void; onUpload: (caption: string) => void | Promise<void>;
}) {
  const { t } = useI18n();
  const [caption, setCaption] = useState('');
  const urls = useMemo(() => p.files.map((f) => URL.createObjectURL(f)), [p.files]);
  useEffect(() => () => urls.forEach((u) => URL.revokeObjectURL(u)), [urls]);
  const sizes = p.files.map((f) => f.size);
  const full = estimateBytes(sizes, false); const est = estimateBytes(sizes, p.dataSaver);
  const tooBig = p.files.filter((f) => f.size > p.maxBytes * 4);       // beyond what in-browser compression can plausibly rescue
  return (
    <div className="stack">
      <h2>{t('guest.preview.title')}</h2>
      <p className="muted">{t('guest.preview.count', { n: p.files.length })} · {t('guest.preview.estimate', { size: formatBytes(est) })}{p.dataSaver && full > est ? ` · ${t('guest.preview.saved', { size: formatBytes(full - est) })}` : ''}</p>
      <div className="thumbs">
        {urls.map((u, i) => (
          <div key={u} className="thumb">
            <img src={u} alt="" />
            <button className="x" onClick={() => p.onRemove(i)} aria-label={t('guest.preview.remove')}>✕</button>
            <span className="sz">{formatBytes(p.files[i].size)}</span>
          </div>
        ))}
      </div>
      <label className="check card flat"><input type="checkbox" checked={p.dataSaver} onChange={(e) => p.onDataSaver(e.target.checked)} /><span><strong>{t('guest.dataSaver')}</strong><br /><span className="small muted">{t('guest.dataSaver.hint')}</span></span></label>
      {p.captionsEnabled && (
        <label className="field"><span>{t('guest.preview.caption')}</span><input type="text" value={caption} maxLength={p.captionMax} onChange={(e) => setCaption(e.target.value)} /><small>{t('guest.preview.captionHint', { n: p.captionMax })}</small></label>
      )}
      {tooBig.length > 0 && <div className="alert error">{t('err.file_too_large')}</div>}
      <div className="actionbar">
        <button className="btn grow" onClick={p.onCancel}>{t('common.cancel')}</button>
        <button className="btn primary grow" disabled={tooBig.length > 0 || p.files.length === 0} onClick={() => p.onUpload(caption)}>{t('guest.preview.upload', { n: p.files.length })}</button>
      </div>
    </div>
  );
}
