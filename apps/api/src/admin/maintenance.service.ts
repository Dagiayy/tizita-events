import { Inject, Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { AppConfig, CONFIG } from '../common/config';
import { ExportsService } from '../exports/exports.service';
import { LifecycleService } from '../events/lifecycle.service';
import { Db } from '../infra/db.service';
import { IdempotencyService } from '../infra/idempotency.service';
import { QUEUES, QueueService } from '../infra/queue.service';
import { RedisService } from '../infra/redis.service';
import { StorageService, keys } from '../infra/storage.service';
import { ProcessingService } from '../media/processing.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PaymentsService } from '../payments/payments.service';
import { DeletionService } from '../privacy/deletion.service';

/**
 * Background workers and schedulers. Runs only when APP_ROLE is `worker` or `all`.
 * Recovery design (acceptance #28): BullMQ re-queues stalled jobs automatically AND the DB-driven sweeper below re-queues
 * media/exports/notifications stuck in an intermediate state, so a crashed worker never leaves work silently stranded.
 */
@Injectable()
export class MaintenanceService implements OnApplicationBootstrap {
  private readonly log = new Logger('Workers');
  constructor(
    private readonly db: Db, private readonly queues: QueueService, private readonly redis: RedisService, private readonly processing: ProcessingService,
    private readonly exportsSvc: ExportsService, private readonly notify: NotificationsService, private readonly lifecycle: LifecycleService, private readonly deletion: DeletionService,
    private readonly payments: PaymentsService, private readonly storage: StorageService, private readonly idem: IdempotencyService, @Inject(CONFIG) private readonly cfg: AppConfig,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (this.cfg.APP_ROLE === 'api' || this.cfg.isTest) return;
    await this.startWorkers();
  }

  async startWorkers(): Promise<void> {
    this.queues.process<{ mediaId: string }>(QUEUES.media, 3, (job) => this.processing.process(job.data.mediaId, job.attemptsMade + 1, job.attemptsMade + 1 >= (job.opts.attempts ?? 5)));
    this.queues.process<{ exportId: string }>(QUEUES.exports, 1, (job) => this.exportsSvc.build(job.data.exportId));
    this.queues.process<{ notificationId: string }>(QUEUES.notify, 5, (job) => this.notify.deliverQueued(job.data.notificationId));
    this.queues.process<{ jobId: string }>(QUEUES.deletion, 1, (job) => this.deletion.run(job.data.jobId));
    this.queues.process<{ kind: string }>(QUEUES.maintenance, 1, async (job) => (job.data.kind === 'heavy' ? this.runAll() : this.runTick()));
    const q = this.queues.queue(QUEUES.maintenance);
    await q.upsertJobScheduler('tick', { every: this.cfg.LIFECYCLE_TICK_SEC * 1000 }, { name: 'tick', data: { kind: 'tick' }, opts: { removeOnComplete: true, removeOnFail: 50, attempts: 1 } });
    await q.upsertJobScheduler('heavy', { every: 10 * 60_000 }, { name: 'heavy', data: { kind: 'heavy' }, opts: { removeOnComplete: true, removeOnFail: 50, attempts: 1 } });
    this.log.log('workers started (media, exports, notify, deletion, maintenance)');
  }

  /** Frequent, cheap: clock-driven lifecycle, due deletions, stuck-work recovery. */
  async runTick() {
    const lifecycle = await this.lifecycle.tick();
    const deletions = await this.deletion.runDue();
    const recovered = await this.recoverStuck();
    return { lifecycle, deletions, recovered };
  }

  /** Heavier housekeeping (every 10 minutes): exports expiry, idempotency purge, reconciliation, stale uploads. */
  async runAll() {
    const lock = await this.redis.client.set('lock:maintenance:heavy', '1', 'EX', 540, 'NX');
    if (!lock) return { skipped: true };
    const out: Record<string, unknown> = {};
    out.expired_exports = await this.exportsSvc.expireOld();
    out.idempotency_purged = await this.idem.purgeOld();
    out.stale_uploads = await this.cleanStaleUploads();
    const today = await this.db.one(`SELECT 1 FROM reconciliation_runs WHERE provider = $1 AND run_date = (now() AT TIME ZONE 'Africa/Addis_Ababa')::date`, [this.cfg.PAYMENT_PROVIDER]);
    if (!today || new Date().getUTCHours() % 6 === 0) { try { out.reconciliation = (await this.payments.reconcile()).id; } catch (e) { out.reconciliation_error = (e as Error).message; } }
    return out;
  }

  /** Re-queues media whose worker died mid-flight, and notifications that never left the queue. */
  async recoverStuck() {
    const media = await this.db.many<{ id: string; processing_attempts: number }>(
      `SELECT id, processing_attempts FROM media WHERE upload_state IN ('uploaded','processing') AND COALESCE(completed_at, created_at) < now() - interval '3 minutes'
         AND processed_at IS NULL AND processing_attempts < 5 LIMIT 100`);
    for (const m of media) {
      await this.db.query(`UPDATE media SET upload_state = 'uploaded' WHERE id = $1 AND upload_state = 'processing'`, [m.id]);
      await this.queues.add(QUEUES.media, 'process', { mediaId: m.id }, { jobId: `media-${m.id}-r${m.processing_attempts}` }).catch(() => undefined);
    }
    const exp = await this.db.many<{ id: string }>(`SELECT id FROM exports WHERE state IN ('queued','processing') AND created_at < now() - interval '10 minutes' LIMIT 20`);
    for (const x of exp) await this.queues.add(QUEUES.exports, 'build', { exportId: x.id }, { jobId: `export-${x.id}-r${Date.now()}` }).catch(() => undefined);
    const notes = await this.db.many<{ id: string }>(`SELECT id FROM notifications WHERE state = 'queued' AND created_at < now() - interval '5 minutes' AND attempts < 6 LIMIT 50`);
    for (const n of notes) await this.queues.add(QUEUES.notify, 'send', { notificationId: n.id }, { jobId: `notify-${n.id}-r${Date.now()}` }).catch(() => undefined);
    // media stuck beyond the retry budget is failed explicitly (visible to hosts/admins), never silently dropped
    await this.db.query(`UPDATE media SET upload_state = 'failed', failure_code = 'processing_timeout', processed_at = now() WHERE upload_state IN ('uploaded','processing') AND processing_attempts >= 5 AND processed_at IS NULL`);
    return { media: media.length, exports: exp.length, notifications: notes.length };
  }

  async cleanStaleUploads(): Promise<number> {
    const rows = await this.db.many<{ id: string; event_id: string }>(
      `UPDATE media SET upload_state = 'cancelled', failure_code = 'abandoned' WHERE upload_state IN ('intent','uploading') AND created_at < now() - interval '2 hours' RETURNING id, event_id`);
    for (const r of rows) await this.storage.deletePrefix('quarantine', keys.quarantinePrefix(r.event_id, r.id)).catch(() => undefined);
    return rows.length;
  }
}
