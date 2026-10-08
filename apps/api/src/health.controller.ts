import { Controller, Get, Header, Headers, Res } from '@nestjs/common';
import type { Response } from 'express';
import { Inject } from '@nestjs/common';
import { Public } from './auth/auth.guard';
import { AppConfig, CONFIG } from './common/config';
import { safeEqual } from './common/crypto';
import { E } from './common/errors';
import { Db } from './infra/db.service';
import { MetricsService } from './infra/metrics.service';
import { QueueService } from './infra/queue.service';
import { RedisService } from './infra/redis.service';
import { StorageService } from './infra/storage.service';
import { ScanService } from './media/scan.service';

@Controller()
export class HealthController {
  constructor(
    private readonly db: Db, private readonly redis: RedisService, private readonly storage: StorageService, private readonly scan: ScanService,
    private readonly metrics: MetricsService, private readonly queues: QueueService, @Inject(CONFIG) private readonly cfg: AppConfig,
  ) {}

  @Get('health/live') @Public()
  live() { return { status: 'ok' }; }

  @Get('health/ready') @Public()
  async ready(@Res({ passthrough: true }) res: Response) {
    const checks: Record<string, boolean> = {};
    checks.database = await this.db.query('SELECT 1').then(() => true).catch(() => false);
    checks.redis = await this.redis.client.ping().then((p) => p === 'PONG').catch(() => false);
    checks.storage = await this.storage.ping();
    checks.antivirus = await this.scan.ping();
    const ok = Object.values(checks).every(Boolean);
    if (!ok) res.status(503);
    return { status: ok ? 'ready' : 'degraded', checks };
  }

  /** Prometheus scrape endpoint, protected by a bearer token. Includes queue backlog gauges. */
  @Get('metrics') @Public() @Header('Content-Type', 'text/plain; version=0.0.4')
  async prom(@Headers('authorization') auth?: string) {
    const token = /^Bearer (.+)$/i.exec(auth ?? '')?.[1] ?? '';
    if (!safeEqual(token, this.cfg.METRICS_TOKEN)) throw E.unauthorized('metrics_auth');
    return this.metrics.render();
  }
}
