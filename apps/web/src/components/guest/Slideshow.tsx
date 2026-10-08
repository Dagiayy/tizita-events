'use client';
import { useEffect, useRef, useState } from 'react';
import { ApiError, request } from '@/lib/api';
import { useI18n } from '@/lib/i18n';

/**
 * Basic live slideshow for an event display (D12): approved photos auto-advance; new approvals join the loop.
 * Uses the gallery link (view-only scope). Open it on the venue screen: /slideshow/<gallery token>?c=<code if required>
 */
export function Slideshow({ locator }: { locator: string }) {
  const { t } = useI18n();
  const [urls, setUrls] = useState<string[]>([]); const [idx, setIdx] = useState(0); const [err, setErr] = useState<string | null>(null);
  const token = useRef<string | null>(null);

  useEffect(() => {
    let stop = false; let es: EventSource | null = null;
    (async () => {
      try {
        const code = new URLSearchParams(window.location.search).get('c') ?? undefined;
        const j = await request<{ token: string }>(`/events/${encodeURIComponent(locator)}/join`, { method: 'POST', json: { code, passcode: code } });
        token.current = j.token;
        const list = await request<{ items: { urls: { viewer: string } }[] }>('/guest/media?limit=60', { token: j.token });
        if (!stop) setUrls(list.items.map((i) => i.urls.viewer));
        const { ticket } = await request<{ ticket: string }>('/guest/live-ticket', { method: 'POST', json: {}, token: j.token });
        es = new EventSource(`${process.env.NEXT_PUBLIC_API_BASE ?? ''}/v1/live?ticket=${ticket}`);
        es.addEventListener('media.published', (e) => { const u = JSON.parse((e as MessageEvent).data).media.urls.viewer as string; setUrls((p) => [u, ...p]); setIdx(0); });
      } catch (e) { if (!stop) setErr(e instanceof ApiError ? e.code : 'generic'); }
    })();
    return () => { stop = true; es?.close(); };
  }, [locator]);
  useEffect(() => { if (urls.length < 2) return; const h = setInterval(() => setIdx((i) => (i + 1) % urls.length), 6000); return () => clearInterval(h); }, [urls.length]);
  if (err) return <div className="slideshow"><p>{t(`err.${err}`) === `err.${err}` ? t('err.generic') : t(`err.${err}`)}</p></div>;
  return <div className="slideshow">{urls.length ? <img key={urls[idx % urls.length]} src={urls[idx % urls.length]} alt="" /> : <p>{t('guest.slideshow.waiting')}</p>}</div>;
}
