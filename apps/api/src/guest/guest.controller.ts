import { Body, Controller, Get, HttpCode, Param, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { AnalyticsService, CLIENT_METRICS } from '../analytics/analytics.service';
import { Auth, Me, Public } from '../auth/auth.guard';
import { E } from '../common/errors';
import { Principal } from '../common/request-context';
import { parse } from '../common/zod.pipe';
import { RedisService } from '../infra/redis.service';
import { GuestService } from './guest.service';

@Controller('v1')
export class GuestController {
  constructor(private readonly guests: GuestService, private readonly analytics: AnalyticsService, private readonly redis: RedisService) {}

  /** GET /events/:token/context - public, minimal event identity + what credentials are needed. */
  @Get('events/:token/context') @Public()
  context(@Param('token') token: string, @Req() req: Request, @Query('lang') lang?: string, @Query('preview') preview?: string) {
    return this.guests.context(token, req.ip ?? null, lang === 'am' ? 'am' : lang === 'en' ? 'en' : undefined, preview === '1');
  }

  /** POST /events/:token/verify - optional host-controlled phone verification (request code / confirm code). */
  @Post('events/:token/verify') @Public() @HttpCode(200)
  verify(@Param('token') token: string, @Body() body: unknown, @Req() req: Request) {
    const b = parse(z.object({ phone: z.string().min(5).max(20), code: z.string().min(4).max(8).optional() }), body);
    return this.guests.verify(token, b, req.ip ?? null);
  }

  /** POST /events/:token/join - creates (or extends) a short-lived signed guest session. No account needed. */
  @Post('events/:token/join') @Public() @HttpCode(200)
  join(@Param('token') token: string, @Body() body: unknown, @Req() req: Request) {
    const bearer = /^Bearer (.+)$/i.exec(req.header('authorization') ?? '')?.[1];
    return this.guests.join(token, body, req.ip ?? null, bearer);
  }

  @Post('guest/refresh') @Auth({ kind: 'guest' }) @HttpCode(200)
  refresh(@Me() me: Principal) {
    const g = me as Extract<Principal, { kind: 'guest' }>;
    return this.guests.refresh(g.sessionId, g.eventId);
  }

  @Get('guest/me') @Auth({ kind: 'guest' })
  me(@Me() me: Principal) { return this.guests.me((me as any).sessionId); }

  /** Privacy-minimised funnel pings from the client. Allow-listed metrics only; aggregate counters, no payloads. */
  @Post('guest/analytics') @Auth({ kind: 'guest' }) @HttpCode(204)
  async track(@Me() me: Principal, @Body() body: unknown) {
    const g = me as Extract<Principal, { kind: 'guest' }>;
    const b = parse(z.object({ metric: z.enum(CLIENT_METRICS) }), body);
    await this.redis.hit(`an:${g.sessionId}`, 120, 600);
    this.analytics.inc(g.eventId, b.metric);
    await this.analytics.step(g.sessionId, g.eventId, b.metric);
  }
}
void E;
