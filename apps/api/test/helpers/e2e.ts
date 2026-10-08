import { Harness } from './harness';
import { MaintenanceService } from '../../src/admin/maintenance.service';

export async function startServer(h: Harness): Promise<string> {
  await h.app.listen(0);
  const addr = h.app.getHttpServer().address();
  return `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
}

export async function startWorkers(h: Harness): Promise<void> {
  await h.get<MaintenanceService>(MaintenanceService).startWorkers();
}

export async function waitFor<T>(fn: () => Promise<T | null | false | undefined>, ms = 30_000, step = 150): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v as T;
    if (Date.now() - t0 > ms) throw new Error(`waitFor timed out after ${ms} ms`);
    await new Promise((r) => setTimeout(r, step));
  }
}

export interface SseHandle { events: { event: string; data: any }[]; waitFor: (pred: (e: { event: string; data: any }) => boolean, ms?: number) => Promise<{ event: string; data: any }>; close: () => void }

/** Minimal SSE client over fetch so tests exercise the real streaming endpoint. */
export async function openSse(base: string, ticket: string): Promise<SseHandle> {
  const ctrl = new AbortController();
  const res = await fetch(`${base}/v1/live?ticket=${ticket}`, { signal: ctrl.signal });
  if (res.status !== 200) throw new Error(`SSE status ${res.status}`);
  const events: SseHandle['events'] = [];
  const reader = res.body!.getReader(); const dec = new TextDecoder(); let buf = '';
  (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read(); if (done) break;
        buf += dec.decode(value, { stream: true });
        let i: number;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          const ev = /^event: (.+)$/m.exec(block)?.[1]; const data = /^data: (.+)$/m.exec(block)?.[1];
          if (ev && data) events.push({ event: ev, data: JSON.parse(data) });
        }
      }
    } catch { /* aborted */ }
  })();
  return {
    events,
    waitFor: (pred, ms = 8000) => waitFor(async () => events.find(pred), ms, 50),
    close: () => ctrl.abort(),
  };
}

// ----------------------------------------------------------------------------- network simulation (Ethiopia matrix)
export interface NetworkProfile { name: string; rttMs: number; kbps: number; lossRate: number; outage?: { afterChunks: number; chunks: number } }
export const PROFILES: Record<string, NetworkProfile> = {
  wifi: { name: 'Venue Wi-Fi', rttMs: 20, kbps: 20_000, lossRate: 0 },
  ethio_telecom_4g: { name: 'Ethio telecom 4G (typical)', rttMs: 90, kbps: 6_000, lossRate: 0.01 },
  safaricom_4g: { name: 'Safaricom Ethiopia 4G', rttMs: 70, kbps: 8_000, lossRate: 0.01 },
  slow_4g: { name: 'Congested 4G (2 Mbps)', rttMs: 250, kbps: 2_000, lossRate: 0.03 },
  ethio_telecom_3g: { name: 'Ethio telecom 3G / weak signal', rttMs: 400, kbps: 700, lossRate: 0.08 },
  connection_loss: { name: 'Temporary connectivity loss', rttMs: 120, kbps: 3_000, lossRate: 0.02, outage: { afterChunks: 3, chunks: 6 } },
};

/**
 * Client-side upload engine model: sequential chunks over a lossy, slow link with exponential backoff and resume.
 * Time is VIRTUAL (accumulated, not slept) so the test can assert "usable on slow 4G" deterministically.
 */
export async function uploadOverNetwork(base: string, token: string, buf: Buffer, p: NetworkProfile, rnd: () => number, post: (path: string, init: RequestInit) => Promise<Response>) {
  let virtualMs = 0; let retries = 0; let wireBytes = 0; let progress: number[] = [];
  const intentRes = await post('/v1/guest/uploads/intents', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ mime: 'image/jpeg', size: buf.length }) });
  virtualMs += p.rttMs;
  const intent: any = await intentRes.json();
  const up = intent.upload; const mediaId = intent.media_id;
  const sent = new Set<number>(); let outageLeft = 0; let attemptsTotal = 0;
  for (let i = 0; i < up.total_chunks; i++) {
    const part = buf.subarray(i * up.chunk_bytes, Math.min((i + 1) * up.chunk_bytes, buf.length));
    let attempt = 0;
    for (;;) {
      attempt++; attemptsTotal++;
      const transfer = p.rttMs + (part.length * 8) / p.kbps;           // ms
      if (p.outage && i === p.outage.afterChunks && outageLeft === 0 && !sent.has(-1)) { sent.add(-1); outageLeft = p.outage.chunks; }
      const lost = outageLeft > 0 || rnd() < p.lossRate;
      if (outageLeft > 0) outageLeft--;
      if (lost) {
        // half of the losses happen AFTER the server stored the chunk but before the ACK arrived: the retry must be harmless
        if (rnd() < 0.5) { await post(`/v1/uploads/${mediaId}/chunks/${i}`, { method: 'PUT', headers: { 'x-upload-token': up.token, 'content-type': 'application/octet-stream' }, body: part }); wireBytes += part.length; }
        virtualMs += transfer * 0.6 + Math.min(30_000, 500 * 2 ** (attempt - 1));        // timeout + exponential backoff
        retries++;
        if (attempt > 12) throw new Error('gave up');
        continue;
      }
      const r = await post(`/v1/uploads/${mediaId}/chunks/${i}`, { method: 'PUT', headers: { 'x-upload-token': up.token, 'content-type': 'application/octet-stream' }, body: part });
      if (r.status !== 200) throw new Error(`chunk ${i} -> ${r.status}`);
      wireBytes += part.length; virtualMs += transfer; sent.add(i); progress.push(Math.round(((i + 1) / up.total_chunks) * 100));
      break;
    }
  }
  const done = await post(`/v1/media/${mediaId}/complete`, { method: 'POST', headers: { 'x-upload-token': up.token } });
  virtualMs += p.rttMs;
  return { mediaId, status: done.status, virtualSeconds: virtualMs / 1000, retries, wireBytes, progress, attemptsTotal, chunks: up.total_chunks };
}

/** Small deterministic PRNG so network scenarios are reproducible. */
export function prng(seed: number) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; }; }
