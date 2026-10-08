import { Injectable } from '@nestjs/common';
import type { Response } from 'express';
import { randomToken } from '../common/crypto';
import { E } from '../common/errors';
import { RedisService } from '../infra/redis.service';

export type RealtimeAudience = 'public' | 'staff';

/**
 * Live gallery fan-out over locally hosted Redis pub/sub + Server-Sent Events (no third-party realtime SaaS).
 * Two separate channels per event keep private moderation state off the guest stream:
 *   ev:{id}:public  -> only approved media (and removals/state changes)   -> guests with gallery scope
 *   ev:{id}:staff   -> every media state transition incl. pending/rejected -> owner/moderators only
 * SSE connections authenticate with a single-use, 60 s ticket so no long-lived token appears in a URL.
 */
@Injectable()
export class RealtimeService {
  constructor(private readonly redis: RedisService) {}

  private channel(eventId: string, a: RealtimeAudience) { return `ev:${eventId}:${a}`; }

  publish(eventId: string, audience: RealtimeAudience, message: Record<string, unknown>): void {
    this.redis.publish(this.channel(eventId, audience), message).catch(() => undefined);
  }

  async issueTicket(eventId: string, audience: RealtimeAudience, who: string): Promise<{ ticket: string; expires_in: number }> {
    const ticket = randomToken(24);
    await this.redis.client.set(`rt:ticket:${ticket}`, JSON.stringify({ eventId, audience, who }), 'EX', 60);
    return { ticket, expires_in: 60 };
  }

  async open(ticket: string, res: Response): Promise<void> {
    const key = `rt:ticket:${ticket}`;
    const raw = await this.redis.client.getdel(key);
    if (!raw) throw E.unauthorized('invalid_ticket', 'Live connection ticket is invalid or expired.');
    const { eventId, audience } = JSON.parse(raw) as { eventId: string; audience: RealtimeAudience };
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no',
    });
    res.write('retry: 3000\n\n');
    const dispose = await this.redis.subscribe(this.channel(eventId, audience), (m) => {
      try { const j = JSON.parse(m); res.write(`event: ${j.type ?? 'message'}\ndata: ${m}\n\n`); } catch { /* ignore */ }
    });
    const ping = setInterval(() => res.write(': ping\n\n'), 20_000);
    // Hard stop after 30 minutes so clients re-authenticate (and blocked sessions drop off).
    const kill = setTimeout(() => res.end(), 30 * 60_000);
    res.on('close', () => { clearInterval(ping); clearTimeout(kill); void dispose(); });
  }
}
