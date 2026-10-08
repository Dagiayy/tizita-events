import { Body, Controller, Get, Headers, HttpCode, Param, Post, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { Auth, Me, Public } from '../auth/auth.guard';
import { E } from '../common/errors';
import { Principal } from '../common/request-context';
import { parse, uuid } from '../common/zod.pipe';
import { AppConfig, CONFIG } from '../common/config';
import { Inject } from '@nestjs/common';
import { PaymentsService } from './payments.service';
import { SandboxProvider } from './providers';

@Controller('v1')
export class PaymentsController {
  constructor(private readonly payments: PaymentsService, @Inject(CONFIG) private readonly cfg: AppConfig) {}

  @Get('plans') @Public()
  plans(@Query('lang') lang?: string) { return this.payments.plans(lang === 'am' ? 'am' : 'en'); }

  @Post('payments/orders') @Auth({ kind: 'user' }) @HttpCode(200)
  createOrder(@Me() me: Principal, @Body() body: unknown, @Headers('idempotency-key') idem?: string) {
    return this.payments.createOrder(me, parse(z.object({ event_id: z.string().uuid(), plan_code: z.string().min(2).max(60) }).strict(), body), idem);
  }

  @Post('events/:id/activate-trial') @Auth({ kind: 'user' }) @HttpCode(200)
  trial(@Me() me: Principal, @Param('id') id: string) { return this.payments.activateTrial(me, parse(uuid, id)); }

  @Get('payments/:orderId/status') @Auth({ kind: 'user' })
  status(@Me() me: Principal, @Param('orderId') id: string) { return this.payments.status(me, parse(uuid, id)); }

  @Get('events/:id/payments') @Auth({ kind: 'user' })
  forEvent(@Me() me: Principal, @Param('id') id: string) { return this.payments.listForEvent(me, parse(uuid, id)); }

  /**
   * Provider callback. Requires the RAW body for signature verification. A valid signature only authenticates the
   * message; activation still requires the server-to-server verification inside PaymentsService.settle().
   */
  @Post('payments/callbacks/:provider') @Public()
  async callback(@Param('provider') provider: string, @Req() req: Request, @Res() res: Response) {
    const raw: Buffer = (req as any).rawBody ?? (Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body ?? {})));
    const out = await this.payments.handleCallback(provider, req.headers, raw);
    res.status(out.status).json(out.body);
  }

  // ---------------------------------------------------------------- sandbox gateway simulator (never in production)
  @Post('dev/sandbox/pay') @Public() @HttpCode(200)
  async sandboxPay(@Body() body: unknown) {
    if (this.cfg.isProd || this.cfg.PAYMENT_PROVIDER !== 'sandbox') throw E.notFound();
    const b = parse(z.object({ tx_ref: z.string().min(8).max(60), outcome: z.enum(['success', 'failed', 'cancelled']) }), body);
    const prov = this.payments.provider('sandbox') as SandboxProvider;
    const db = (this.payments as any).db;
    await db.query('UPDATE sandbox_transactions SET status = $2 WHERE tx_ref = $1', [b.tx_ref, b.outcome]);
    const raw = Buffer.from(JSON.stringify({ tx_ref: b.tx_ref, status: b.outcome, reference: `sbx_${b.tx_ref}` }));
    const r = await this.payments.handleCallback('sandbox', { 'x-sandbox-signature': prov.sign(raw) }, raw);
    return { ok: r.status < 300, ...r.body };
  }
}
