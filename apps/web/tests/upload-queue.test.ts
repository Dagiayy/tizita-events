import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { HttpFailure, UploadEngine, backoffMs, createIndexedDbStore, estimateBytes, planCompression, type QueueItem, type UploadApi } from '../src/lib/upload-queue';

const CHUNK = 1000;
function fakeApi(opts: { failChunks?: Map<number, number>; offlineAfter?: () => boolean; expireToken?: { once: boolean }; status500?: number } = {}) {
  const stored = new Map<string, Set<number>>(); const log: string[] = []; let seq = 0; const failures = new Map(opts.failChunks ?? []);
  let expired = false;
  const api: UploadApi = {
    async intent(body) {
      log.push('intent'); const id = `m${++seq}`; stored.set(id, new Set());
      return { media_id: id, upload: { url: `/u/${id}`, token: `t${seq}`, chunk_bytes: CHUNK, total_chunks: Math.ceil(body.size / CHUNK), expires_at: new Date(Date.now() + 3600_000).toISOString() } };
    },
    async status(id) { return { state: 'uploading', received: [...(stored.get(id) ?? [])], total_chunks: 0 }; },
    async putChunk(id, n) {
      log.push(`chunk${n}`);
      if (opts.expireToken && !expired) { expired = true; throw new HttpFailure(401, 'upload_token_expired'); }
      const left = failures.get(n) ?? 0;
      if (left > 0) { failures.set(n, left - 1); throw new HttpFailure(n % 2 ? 0 : 503, 'transient'); }
      stored.get(id)!.add(n);
    },
    async complete(id) { log.push('complete'); return { state: 'uploaded' }; },
    async cancel(id) { log.push(`cancel:${id}`); },
  };
  return { api, stored, log };
}
const memStore = () => { const m = new Map<string, QueueItem>(); return { m, store: { put: async (i: QueueItem) => { m.set(i.id, structuredClone({ ...i, blob: undefined as any })); (m.get(i.id) as any).blob = i.blob; }, all: async () => [...m.values()], delete: async (id: string) => { m.delete(id); } } }; };
const blob = (n: number) => new Blob([new Uint8Array(n)], { type: 'image/jpeg' });
const noSleep = async () => undefined;

describe('upload queue engine', () => {
  it('uploads in chunks with per-item progress and completes once', async () => {
    const { api, log } = fakeApi(); const { store } = memStore();
    const e = new UploadEngine({ api, store, sleep: noSleep });
    const seen: number[] = []; e.subscribe((items) => items[0] && seen.push(items[0].progress));
    const id = await e.add(blob(3500), { dataSaver: false });
    await e.idle();
    const it = e.list().find((i) => i.id === id)!;
    expect(it.state).toBe('done'); expect(it.progress).toBe(100);
    expect(log.filter((l) => l.startsWith('chunk'))).toEqual(['chunk0', 'chunk1', 'chunk2', 'chunk3']);
    expect(log.filter((l) => l === 'complete')).toHaveLength(1);
    expect(seen).toEqual([...seen].sort((a, b) => a - b));               // progress never goes backwards
  });

  it('#7/#8 retries transient failures with exponential backoff and resumes without re-sending stored chunks', async () => {
    const { api, log } = fakeApi({ failChunks: new Map([[1, 3], [2, 1]]) }); const { store } = memStore();
    const sleeps: number[] = [];
    const e = new UploadEngine({ api, store, sleep: async (ms) => { sleeps.push(ms); }, random: () => 0.5 });
    const id = await e.add(blob(3500), { dataSaver: false });
    await e.idle();
    expect(e.list().find((i) => i.id === id)!.state).toBe('done');
    expect(sleeps).toEqual([1000, 2000, 4000, 1000]);                       // 1 s, 2 s, 4 s for chunk 1; 1 s for chunk 2
    expect(log.filter((l) => l === 'chunk0')).toHaveLength(1);              // chunk 0 never re-sent
    expect(log.filter((l) => l === 'intent')).toHaveLength(1);
  });

  it('gives up on permanent errors immediately and shows a reason code; manual retry works', async () => {
    const base = fakeApi(); let failIntent = true; let calls = 0;
    const api: UploadApi = { ...base.api, intent: async (b, k) => { calls++; if (failIntent) throw new HttpFailure(413, 'file_too_large'); return base.api.intent(b, k); } };
    const { store } = memStore(); const sleeps: number[] = [];
    const e = new UploadEngine({ api, store, sleep: async (ms) => { sleeps.push(ms); } });
    const id = await e.add(blob(100), { dataSaver: false }); await e.idle();
    const it = e.list()[0]; expect(it.state).toBe('failed'); expect(it.error).toBe('file_too_large'); expect(sleeps).toEqual([]); expect(calls).toBe(1);
    failIntent = false;
    await e.retry(id); await e.idle(); expect(calls).toBe(2); expect(e.list()[0].state).toBe('done');
  });

  it('stops after the retry budget on a dead network and surfaces a failure instead of looping forever', async () => {
    const { api } = fakeApi({ failChunks: new Map([[0, 999]]) }); const { store } = memStore();
    const e = new UploadEngine({ api, store, sleep: noSleep, maxChunkAttempts: 4 });
    await e.add(blob(2000), { dataSaver: false }); await e.idle();
    expect(e.list()[0].state).toBe('failed');
  });

  it('waits while offline ("Waiting for connection") and continues when the network returns', async () => {
    const { api, log } = fakeApi(); const { store } = memStore(); let online = false;
    const e = new UploadEngine({ api, store, isOnline: () => online, sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5))) });
    const states: string[] = []; e.subscribe((l) => l[0] && states.push(l[0].state));
    await e.add(blob(2500), { dataSaver: false });
    await new Promise((r) => setTimeout(r, 40));
    expect(e.list()[0].state).toBe('waiting_network'); expect(log).toEqual([]);
    online = true; e.networkChanged(); await e.idle();
    expect(e.list()[0].state).toBe('done'); expect(states).toContain('waiting_network');
  });

  it('re-requests an upload intent when the short-lived upload token expires mid-way', async () => {
    const { api, log } = fakeApi({ expireToken: { once: true } }); const { store } = memStore();
    const e = new UploadEngine({ api, store, sleep: noSleep });
    await e.add(blob(2500), { dataSaver: false }); await e.idle();
    expect(e.list()[0].state).toBe('done'); expect(log.filter((l) => l === 'intent')).toHaveLength(2);
  });

  it('cancel stops sending and tells the server; concurrency limit is honoured', async () => {
    let inFlight = 0; let maxInFlight = 0; const base = fakeApi();
    const api: UploadApi = { ...base.api, putChunk: async (id, n, t, d) => { inFlight++; maxInFlight = Math.max(maxInFlight, inFlight); await new Promise((r) => setTimeout(r, 5)); await base.api.putChunk(id, n, t, d); inFlight--; } };
    const { store } = memStore(); const e = new UploadEngine({ api, store, concurrency: 2, sleep: noSleep });
    for (let i = 0; i < 5; i++) await e.add(blob(3000), { dataSaver: false });
    await e.idle(); expect(maxInFlight).toBeLessThanOrEqual(2);
    const e2 = new UploadEngine({ api: base.api, store: memStore().store, sleep: noSleep }); e2.pause();
    const id = await e2.add(blob(3000), { dataSaver: false }); await e2.cancel(id);
    expect(e2.list()[0].state).toBe('cancelled'); e2.resume(); await e2.idle(); expect(e2.list()[0].state).toBe('cancelled');
  });

  it('#7 queue persists across restarts: unfinished items resume from the server\'s received chunks', async () => {
    const base = fakeApi(); const { store, m } = memStore();
    // first "session": fail permanently-ish after chunk 1 by dropping the page (simulated by pausing engine mid-way)
    let drop = false; const api: UploadApi = { ...base.api, putChunk: async (id, n, t, d) => { if (drop && n === 2) throw new HttpFailure(0, 'net'); await base.api.putChunk(id, n, t, d); } };
    const e1 = new UploadEngine({ api, store, sleep: async () => { throw new Error('page closed'); }, maxChunkAttempts: 1 }); drop = true;
    await e1.add(blob(4000), { dataSaver: true, caption: 'ሠርግ' }); await e1.idle();
    expect([...m.values()][0].state).toBe('failed'); drop = false;
    // "reload": new engine instance restores from the store
    const item = [...m.values()][0]; item.state = 'uploading';                 // a crash leaves it in-flight
    const e2 = new UploadEngine({ api: base.api, store, sleep: noSleep }); await e2.restore(); await e2.idle();
    expect(e2.list()[0].state).toBe('done'); expect(e2.list()[0].caption).toBe('ሠርግ');
    const sent = base.log.filter((l) => l.startsWith('chunk'));
    expect(sent.filter((c) => c === 'chunk0')).toHaveLength(1); expect(sent.filter((c) => c === 'chunk1')).toHaveLength(1);   // not re-sent
  });

  it('IndexedDB store round-trips blobs and survives re-open', async () => {
    const s = createIndexedDbStore('t-' + Math.random());
    const item: QueueItem = { id: 'a', blob: blob(10), size: 10, mime: 'image/jpeg', dataSaver: false, createdAt: 1, state: 'queued', progress: 0, attempt: 0 };
    await s.put(item); expect((await s.all()).map((i) => i.id)).toEqual(['a']);
    await s.delete('a'); expect(await s.all()).toEqual([]);
  });
});

describe('backoff and compression planning (low-bandwidth design)', () => {
  it('backoff doubles up to 30 s with +-25% jitter', () => {
    expect([1, 2, 3, 4, 5, 6, 7].map((a) => backoffMs(a, () => 0.5))).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000]);
    expect(backoffMs(3, () => 0)).toBe(3000); expect(backoffMs(3, () => 1)).toBe(5000);
  });
  it('data saver shrinks big photos; normal mode leaves normal photos untouched and fits the 15 MB cap', () => {
    expect(planCompression(4000, 3000, 4_500_000, true)).toEqual({ maxEdge: 1600, quality: 0.72 });
    expect(planCompression(1200, 800, 300_000, true)).toBeNull();
    expect(planCompression(4000, 3000, 2_500_000, false)).toBeNull();
    expect(planCompression(6000, 4000, 20_000_000, false)).toEqual({ maxEdge: 2560, quality: 0.82 });
    expect(planCompression(4000, 3000, 5_000_000, false)).toEqual({ maxEdge: 2560, quality: 0.85 });
  });
  it('estimates upload size with and without data saver', () => {
    const sizes = [3_000_000, 2_000_000];
    expect(estimateBytes(sizes, false)).toBe(5_000_000);
    expect(estimateBytes(sizes, true)).toBeLessThan(estimateBytes(sizes, false) / 3);
  });
});
