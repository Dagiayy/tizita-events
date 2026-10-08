import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import { AppConfig, CONFIG } from '../common/config';
import { E } from '../common/errors';

@Injectable()
export class RedisService implements OnModuleDestroy {
  readonly client: Redis;
  private readonly subs = new Set<Redis>();
  constructor(@Inject(CONFIG) private readonly cfg: AppConfig) {
    this.client = new Redis(cfg.REDIS_URL, { maxRetriesPerRequest: 3, enableReadyCheck: true, lazyConnect: false });
    this.client.on('error', () => undefined); // surfaced through health checks / failed commands
  }

  /** BullMQ requires its own connections with maxRetriesPerRequest = null. */
  newConnection(blocking = false): Redis {
    const r = new Redis(this.cfg.REDIS_URL, { maxRetriesPerRequest: blocking ? null : 3 });
    r.on('error', () => undefined);
    return r;
  }

  /** Dedicated subscriber connection; caller must call the returned dispose(). */
  async subscribe(channel: string, onMessage: (msg: string) => void): Promise<() => Promise<void>> {
    const sub = this.newConnection();
    this.subs.add(sub);
    await sub.subscribe(channel);
    sub.on('message', (_c, m) => onMessage(m));
    return async () => { this.subs.delete(sub); sub.disconnect(); };
  }

  publish(channel: string, payload: unknown): Promise<number> {
    return this.client.publish(channel, JSON.stringify(payload));
  }

  /**
   * Fixed-window rate limiter. Fails CLOSED: if Redis is unavailable the request is refused,
   * because OTP/join/upload limits are abuse-protection controls.
   */
  async hit(key: string, limit: number, windowSec: number): Promise<{ count: number; remaining: number }> {
    let count: number; let ttl: number;
    try {
      const res = (await this.client
        .multi().incr(`rl:${key}`).ttl(`rl:${key}`).exec()) as [Error | null, number][];
      count = res[0][1]; ttl = res[1][1];
      if (count === 1 || ttl < 0) await this.client.expire(`rl:${key}`, windowSec);
    } catch {
      throw E.unavailable('rate_limiter_unavailable', 'Temporarily unavailable');
    }
    if (count > limit) throw E.tooMany(ttl > 0 ? ttl : windowSec);
    return { count, remaining: Math.max(0, limit - count) };
  }

  async onModuleDestroy(): Promise<void> {
    for (const s of this.subs) s.disconnect();
    await this.client.quit().catch(() => undefined);
  }
}
