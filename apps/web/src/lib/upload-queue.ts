/**
 * Guest upload engine (spec 8, 11): persistent queue, chunked + resumable upload, exponential backoff with jitter,
 * offline awareness, per-item progress, retry and cancel. UI-agnostic and fully injectable so it is unit-tested
 * without a browser. The browser build wires it to IndexedDB, fetch and navigator.onLine.
 */
export type ItemState = 'preparing' | 'queued' | 'uploading' | 'retrying' | 'waiting_network' | 'processing' | 'done' | 'failed' | 'cancelled';

export interface UploadTarget { url: string; token: string; chunk_bytes: number; total_chunks: number; expires_at: string }
export interface QueueItem {
  id: string; blob: Blob; size: number; mime: string; caption?: string; dataSaver: boolean; createdAt: number;
  state: ItemState; progress: number; attempt: number; retryInMs?: number; mediaId?: string; target?: UploadTarget; error?: string;
  /** server-side moderation/processing state learned later (pending | approved | rejected | duplicate | failed) */
  serverState?: string;
}

export interface QueueStore {
  put(item: QueueItem): Promise<void>;
  all(): Promise<QueueItem[]>;
  delete(id: string): Promise<void>;
}

export class HttpFailure extends Error { constructor(public status: number, public code: string) { super(code); } }

export interface UploadApi {
  intent(body: { mime: string; size: number; caption?: string }, idempotencyKey: string): Promise<{ media_id: string; upload: UploadTarget }>;
  status(mediaId: string, token: string): Promise<{ state: string; received: number[]; total_chunks: number }>;
  putChunk(mediaId: string, n: number, token: string, data: Blob): Promise<void>;
  complete(mediaId: string, token: string, idempotencyKey: string): Promise<{ state: string }>;
  cancel(mediaId: string, token: string): Promise<void>;
}

export interface EngineDeps {
  api: UploadApi; store: QueueStore;
  concurrency?: number;
  isOnline?: () => boolean;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  newId?: () => string;
  maxChunkAttempts?: number;
  prepare?: (file: Blob, dataSaver: boolean) => Promise<{ blob: Blob; mime: string }>;
}

/** 1 s, 2 s, 4 s ... capped at 30 s, +/-25% jitter so a venue full of phones does not retry in lock-step. */
export function backoffMs(attempt: number, rnd: () => number = Math.random): number {
  const base = Math.min(30_000, 1000 * 2 ** Math.max(0, attempt - 1));
  return Math.round(base * (0.75 + rnd() * 0.5));
}

/** Failures that will never succeed by retrying. */
const PERMANENT = new Set([
  'file_too_large', 'unsupported_type', 'event_storage_full', 'event_media_limit', 'session_blocked', 'upload_closed', 'event_not_accepting_uploads',
  'outside_upload_window', 'event_state_forbids', 'scope_not_granted', 'session_upload_cap', 'consent_required', 'uploads_disabled', 'invalid_chunk_size', 'size_mismatch', 'media_not_found',
]);
const isTransient = (e: unknown) => e instanceof HttpFailure && (e.status === 0 || e.status === 408 || e.status === 425 || e.status === 429 || e.status >= 500);

export class UploadEngine {
  private items = new Map<string, QueueItem>();
  private running = new Set<string>();
  private listeners = new Set<(items: QueueItem[]) => void>();
  private paused = false;
  private cancelled = new Set<string>();
  private wake: (() => void) | null = null;
  private readonly d: Required<Omit<EngineDeps, 'prepare'>> & { prepare?: EngineDeps['prepare'] };

  constructor(deps: EngineDeps) {
    this.d = {
      concurrency: 2, isOnline: () => true, now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)), random: Math.random,
      newId: () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`, maxChunkAttempts: 8, ...deps,
    };
  }

  subscribe(fn: (items: QueueItem[]) => void): () => void { this.listeners.add(fn); fn(this.list()); return () => { this.listeners.delete(fn); }; }
  list(): QueueItem[] { return [...this.items.values()].sort((a, b) => a.createdAt - b.createdAt); }
  private emit() { const l = this.list(); this.listeners.forEach((f) => f(l)); }
  private async save(it: QueueItem) { this.items.set(it.id, it); this.emit(); await this.d.store.put({ ...it }).catch(() => undefined); }

  /** Reloads persisted items after an app restart / page reload and resumes anything unfinished. */
  async restore(): Promise<void> {
    for (const it of await this.d.store.all()) {
      if (it.state === 'done' || it.state === 'cancelled') { await this.d.store.delete(it.id); continue; }
      if (['uploading', 'retrying', 'waiting_network', 'preparing'].includes(it.state)) it.state = 'queued';
      this.items.set(it.id, it);
    }
    this.emit(); this.pump();
  }

  async add(file: Blob, opts: { dataSaver: boolean; caption?: string }): Promise<string> {
    const id = this.d.newId();
    const prepared = this.d.prepare ? await this.d.prepare(file, opts.dataSaver) : { blob: file, mime: file.type || 'image/jpeg' };
    const it: QueueItem = { id, blob: prepared.blob, size: prepared.blob.size, mime: prepared.mime, caption: opts.caption, dataSaver: opts.dataSaver, createdAt: this.d.now(), state: 'queued', progress: 0, attempt: 0 };
    await this.save(it);
    this.pump();
    return id;
  }

  pause() { this.paused = true; }
  resume() { this.paused = false; this.pump(); }
  /** Called from the `online` event. */
  networkChanged() { this.wake?.(); this.pump(); }

  async retry(id: string) { const it = this.items.get(id); if (!it || !['failed', 'cancelled'].includes(it.state)) return; it.state = 'queued'; it.error = undefined; it.attempt = 0; this.cancelled.delete(id); await this.save(it); this.pump(); }
  async cancel(id: string) {
    const it = this.items.get(id); if (!it) return;
    this.cancelled.add(id);
    if (it.mediaId && it.target && !['done', 'processing'].includes(it.state)) await this.d.api.cancel(it.mediaId, it.target.token).catch(() => undefined);
    it.state = 'cancelled'; await this.save(it);
  }
  async remove(id: string) { this.cancelled.add(id); this.items.delete(id); this.emit(); await this.d.store.delete(id).catch(() => undefined); }
  setServerState(id: string, s: string) { const it = this.items.get(id); if (it) { it.serverState = s; void this.save(it); } }

  /** Resolves when every item is done/failed/cancelled (used by tests and "keep page open" hint). */
  async idle(): Promise<void> {
    for (;;) {
      const busy = this.list().some((i) => ['preparing', 'queued', 'uploading', 'retrying', 'waiting_network'].includes(i.state));
      if (!busy && this.running.size === 0) return;
      await new Promise((r) => setTimeout(r, 5));
    }
  }

  private pump() {
    if (this.paused) return;
    for (const it of this.list()) {
      if (this.running.size >= this.d.concurrency) break;
      if (it.state === 'queued' && !this.running.has(it.id)) { this.running.add(it.id); void this.run(it).finally(() => { this.running.delete(it.id); this.pump(); }); }
    }
  }

  private async waitOnline(it: QueueItem) {
    while (!this.d.isOnline() && !this.cancelled.has(it.id)) {
      it.state = 'waiting_network'; await this.save(it);
      await Promise.race([new Promise<void>((r) => { this.wake = r; }), this.d.sleep(5000)]);
    }
    this.wake = null;
  }

  private async run(it: QueueItem) {
    try {
      it.state = 'uploading'; it.error = undefined; await this.save(it);
      for (let guard = 0; guard < 6; guard++) {
        await this.ensureIntent(it);
        const outcome = await this.sendChunks(it);
        if (outcome === 'cancelled') return;
        if (outcome === 'reintent') { it.target = undefined; it.mediaId = undefined; continue; }
        const done = await this.withRetry(it, () => this.d.api.complete(it.mediaId!, it.target!.token, `complete-${it.id}`));
        if (done === 'cancelled') return;
        it.progress = 100; it.state = 'processing'; await this.save(it);
        it.state = 'done'; await this.save(it);
        return;
      }
      throw new HttpFailure(409, 'upload_closed');
    } catch (e) {
      if (this.cancelled.has(it.id)) return;
      it.state = 'failed'; it.error = e instanceof HttpFailure ? e.code : 'generic'; await this.save(it);
    }
  }

  private async ensureIntent(it: QueueItem) {
    const fresh = it.target && new Date(it.target.expires_at).getTime() - this.d.now() > 60_000;
    if (fresh && it.mediaId) return;
    const r = await this.withRetry(it, () => this.d.api.intent({ mime: it.mime, size: it.size, caption: it.caption }, `intent-${it.id}`));
    if (r === 'cancelled') throw new HttpFailure(0, 'cancelled');
    it.mediaId = r.media_id; it.target = r.upload; await this.save(it);
  }

  /** Sends only the chunks the server does not have yet, so a restart or dropped connection resumes instead of restarting. */
  private async sendChunks(it: QueueItem): Promise<'ok' | 'cancelled' | 'reintent'> {
    const t = it.target!;
    let have = new Set<number>();
    try {
      const st = await this.withRetry(it, () => this.d.api.status(it.mediaId!, t.token));
      if (st === 'cancelled') return 'cancelled';
      have = new Set(st.received);
    } catch (e) { if (e instanceof HttpFailure && (e.code === 'upload_token_expired' || e.code === 'invalid_upload_token' || e.status === 404)) return 'reintent'; throw e; }
    for (let n = 0; n < t.total_chunks; n++) {
      if (this.cancelled.has(it.id)) return 'cancelled';
      if (have.has(n)) continue;
      const part = it.blob.slice(n * t.chunk_bytes, Math.min((n + 1) * t.chunk_bytes, it.size));
      try {
        const r = await this.withRetry(it, () => this.d.api.putChunk(it.mediaId!, n, t.token, part));
        if (r === 'cancelled') return 'cancelled';
      } catch (e) { if (e instanceof HttpFailure && e.code === 'upload_token_expired') return 'reintent'; throw e; }
      have.add(n); it.progress = Math.round((have.size / t.total_chunks) * 100); it.state = 'uploading'; await this.save(it);
    }
    return 'ok';
  }

  /** Runs fn with offline waiting and exponential backoff for transient failures. Permanent errors are re-thrown. */
  private async withRetry<T>(it: QueueItem, fn: () => Promise<T>): Promise<T | 'cancelled'> {
    for (let attempt = 1; ; attempt++) {
      if (this.cancelled.has(it.id)) return 'cancelled';
      await this.waitOnline(it);
      try { const r = await fn(); if (it.state !== 'uploading') { it.state = 'uploading'; it.retryInMs = undefined; await this.save(it); } return r; }
      catch (e) {
        if (e instanceof HttpFailure && PERMANENT.has(e.code)) throw e;
        if (!isTransient(e) || attempt >= this.d.maxChunkAttempts) throw e;
        it.attempt = attempt; it.state = 'retrying'; it.retryInMs = backoffMs(attempt, this.d.random); await this.save(it);
        await this.d.sleep(it.retryInMs);
      }
    }
  }
}

// ------------------------------------------------------------------------------------------------------------------ compression plan
export interface CompressionPlan { maxEdge: number; quality: number }
/**
 * Data-saver: ~1600 px / q0.72. Normal: leave typical photos untouched; shrink very large ones so they fit the 15 MB cap
 * and weak links (> 3 MB -> 2560 px / q0.85). Returns null when the original should be sent as-is.
 */
export function planCompression(width: number, height: number, bytes: number, dataSaver: boolean, maxBytes = 15 * 1024 * 1024): CompressionPlan | null {
  const edge = Math.max(width, height);
  if (dataSaver) return edge > 1600 || bytes > 600 * 1024 ? { maxEdge: Math.min(edge, 1600), quality: 0.72 } : null;
  if (bytes > maxBytes) return { maxEdge: Math.min(edge, 2560), quality: 0.82 };
  if (bytes > 3 * 1024 * 1024 && edge > 2560) return { maxEdge: 2560, quality: 0.85 };
  return null;
}

export function estimateBytes(sizes: number[], dataSaver: boolean): number {
  return sizes.reduce((a, s) => a + (dataSaver ? Math.min(s, Math.max(180 * 1024, s * 0.22)) : s), 0);
}

// ------------------------------------------------------------------------------------------------------------------ browser adapters
export function createIndexedDbStore(dbName = 'ep-upload-queue', idb: IDBFactory | undefined = typeof indexedDB === 'undefined' ? undefined : indexedDB): QueueStore {
  const mem = new Map<string, QueueItem>();
  if (!idb) return { put: async (i) => { mem.set(i.id, i); }, all: async () => [...mem.values()], delete: async (id) => { mem.delete(id); } };
  const open = () => new Promise<IDBDatabase>((resolve, reject) => {
    const r = idb.open(dbName, 1);
    r.onupgradeneeded = () => { r.result.createObjectStore('items', { keyPath: 'id' }); };
    r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error);
  });
  const tx = async <T,>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> => {
    const db = await open();
    return new Promise<T>((resolve, reject) => { const t = db.transaction('items', mode); const req = fn(t.objectStore('items')); req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
  };
  return {
    put: async (i) => { await tx('readwrite', (s) => s.put(i)); },
    all: async () => (await tx('readonly', (s) => s.getAll())) as QueueItem[],
    delete: async (id) => { await tx('readwrite', (s) => s.delete(id)); },
  };
}

/** Canvas based resize/recompress. Falls back to the original when the browser cannot decode the file (e.g. HEIC on Chrome). */
export async function prepareImage(file: Blob, dataSaver: boolean): Promise<{ blob: Blob; mime: string }> {
  const original = { blob: file, mime: file.type || 'image/jpeg' };
  try {
    if (typeof createImageBitmap === 'undefined') return original;
    const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const plan = planCompression(bmp.width, bmp.height, file.size, dataSaver);
    if (!plan) { bmp.close(); return original; }
    const scale = Math.min(1, plan.maxEdge / Math.max(bmp.width, bmp.height));
    const w = Math.max(1, Math.round(bmp.width * scale)); const h = Math.max(1, Math.round(bmp.height * scale));
    const canvas = document.createElement('canvas'); canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d'); if (!ctx) { bmp.close(); return original; }
    ctx.drawImage(bmp, 0, 0, w, h); bmp.close();
    const out: Blob | null = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', plan.quality));
    canvas.width = canvas.height = 0;                                // release memory early on low-end phones
    return out && out.size < file.size ? { blob: out, mime: 'image/jpeg' } : original;
  } catch { return original; }
}
