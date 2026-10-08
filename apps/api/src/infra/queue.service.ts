import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Job, JobsOptions, Queue, Worker } from 'bullmq';
import { RedisService } from './redis.service';

export const QUEUES = {
  media: 'media-process',
  exports: 'export',
  notify: 'notify',
  deletion: 'deletion',
  maintenance: 'maintenance',
} as const;
export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

const DEFAULT_OPTS: JobsOptions = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 2000 },
  removeOnComplete: { age: 3600, count: 1000 },
  removeOnFail: { age: 7 * 24 * 3600 },
};

/**
 * BullMQ over Redis. Producers run in the API process; consumers run in the worker role.
 * Stalled jobs (worker crash) are re-queued automatically; stuck DB rows are re-queued by the
 * maintenance sweeper (see MaintenanceService) so recovery does not depend on Redis alone.
 */
@Injectable()
export class QueueService implements OnModuleDestroy {
  private readonly log = new Logger('Queue');
  private readonly queues = new Map<QueueName, Queue>();
  private readonly workers: Worker[] = [];
  constructor(private readonly redis: RedisService) {}

  queue(name: QueueName): Queue {
    let q = this.queues.get(name);
    if (!q) {
      q = new Queue(name, { connection: this.redis.newConnection(true), defaultJobOptions: DEFAULT_OPTS });
      q.on('error', () => undefined);
      this.queues.set(name, q);
    }
    return q;
  }

  async add<T extends object>(name: QueueName, jobName: string, data: T, opts: JobsOptions = {}): Promise<void> {
    await this.queue(name).add(jobName, data, opts);
  }

  process<T>(name: QueueName, concurrency: number, handler: (job: Job<T>) => Promise<unknown>): Worker {
    const w = new Worker<T>(name, handler, {
      connection: this.redis.newConnection(true),
      concurrency,
      lockDuration: 60_000,
      stalledInterval: 15_000,
      maxStalledCount: 3,
    });
    w.on('failed', (job, err) => this.log.warn(`[${name}] job ${job?.id} (${job?.name}) failed: ${err.message}`));
    w.on('error', () => undefined);
    this.workers.push(w);
    return w;
  }

  async counts(): Promise<Record<string, { waiting: number; active: number; delayed: number; failed: number; completed: number }>> {
    const out: Record<string, any> = {};
    for (const name of Object.values(QUEUES)) {
      const c = await this.queue(name).getJobCounts('waiting', 'active', 'delayed', 'failed', 'completed');
      out[name] = { waiting: c.waiting ?? 0, active: c.active ?? 0, delayed: c.delayed ?? 0, failed: c.failed ?? 0, completed: c.completed ?? 0 };
    }
    return out;
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.all(this.workers.map((w) => w.close().catch(() => undefined)));
    await Promise.all([...this.queues.values()].map((q) => q.close().catch(() => undefined)));
  }
}
