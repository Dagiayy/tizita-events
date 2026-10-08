import { Injectable } from '@nestjs/common';
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';
import { Db } from './db.service';
import { QueueService } from './queue.service';

/** Prometheus metrics, including queue backlog and processing failures (acceptance #29). */
@Injectable()
export class MetricsService {
  readonly registry = new Registry();
  readonly httpDuration = new Histogram({
    name: 'http_request_duration_seconds', help: 'HTTP request latency', labelNames: ['method', 'route', 'status'],
    buckets: [0.01, 0.05, 0.1, 0.3, 0.5, 1, 2, 5], registers: [this.registry],
  });
  readonly mediaProcessed = new Counter({ name: 'media_processed_total', help: 'Media processing outcomes', labelNames: ['outcome'], registers: [this.registry] });
  readonly mediaProcessSeconds = new Histogram({ name: 'media_process_seconds', help: 'Media processing duration', buckets: [0.2, 0.5, 1, 2, 5, 10, 30], registers: [this.registry] });
  readonly uploadsIntent = new Counter({ name: 'upload_intents_total', help: 'Upload intents created', registers: [this.registry] });
  readonly paymentCallbacks = new Counter({ name: 'payment_callbacks_total', help: 'Payment callbacks by outcome', labelNames: ['provider', 'outcome'], registers: [this.registry] });
  readonly queueDepth = new Gauge({ name: 'queue_jobs', help: 'Queue job counts', labelNames: ['queue', 'state'], registers: [this.registry] });
  readonly eventsByState = new Gauge({ name: 'events_by_state', help: 'Events per lifecycle state', labelNames: ['state'], registers: [this.registry] });
  readonly storageBytes = new Gauge({ name: 'storage_bytes_total', help: 'Stored media bytes across events', registers: [this.registry] });
  readonly pendingProcessing = new Gauge({ name: 'media_processing_backlog', help: 'Media waiting for processing in DB', registers: [this.registry] });

  constructor(private readonly queues: QueueService, private readonly db: Db) {
    collectDefaultMetrics({ register: this.registry, prefix: 'nodejs_' });
  }

  async render(): Promise<string> {
    try {
      const counts = await this.queues.counts();
      for (const [q, c] of Object.entries(counts)) for (const [s, n] of Object.entries(c)) this.queueDepth.set({ queue: q, state: s }, n);
      const states = await this.db.many<{ state: string; n: number }>('SELECT state, count(*)::int AS n FROM events GROUP BY state');
      this.eventsByState.reset();
      for (const r of states) this.eventsByState.set({ state: r.state }, r.n);
      const s = await this.db.one<{ b: number; p: number }>(
        `SELECT COALESCE((SELECT sum(storage_bytes) FROM events),0)::bigint AS b,
                (SELECT count(*) FROM media WHERE upload_state IN ('uploaded','processing'))::int AS p`);
      this.storageBytes.set(Number(s?.b ?? 0));
      this.pendingProcessing.set(Number(s?.p ?? 0));
    } catch { /* metrics must never fail the scrape */ }
    return this.registry.metrics();
  }
}
