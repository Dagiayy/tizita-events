import { Body, Controller, Delete, Get, HttpCode, Param, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { E } from '../common/errors';
import { Principal } from '../common/request-context';
import { locale, parse, uuid } from '../common/zod.pipe';
import { Auth, Me, Public } from './auth.guard';
import { AuthService } from './auth.service';
import { AppConfig, CONFIG } from '../common/config';
import { Inject } from '@nestjs/common';

const COOKIE = 'rt';

@Controller('v1')
export class AuthController {
  constructor(private readonly auth: AuthService, @Inject(CONFIG) private readonly cfg: AppConfig) {}

  private isWeb(req: Request): boolean { return req.header('x-client-kind') === 'web'; }

  /** Web console keeps the refresh token in an HttpOnly cookie (not readable by page scripts). */
  private setCookie(res: Response, token: string): void {
    res.cookie(COOKIE, token, {
      httpOnly: true, secure: this.cfg.isProd, sameSite: 'strict', path: '/v1/auth', maxAge: this.cfg.REFRESH_TOKEN_TTL_SEC * 1000,
    });
  }

  @Post('auth/request-otp') @Public() @HttpCode(200)
  requestOtp(@Body() body: unknown, @Req() req: Request) {
    const b = parse(z.object({ phone: z.string().min(5).max(20), locale: locale.default('en') }), body);
    return this.auth.requestOtp(b.phone, b.locale, req.ip ?? null);
  }

  @Post('auth/verify-otp') @Public() @HttpCode(200)
  async verifyOtp(@Body() body: unknown, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const b = parse(z.object({
      phone: z.string().min(5).max(20), code: z.string().min(4).max(8),
      device_label: z.string().max(80).optional(), recovery: z.boolean().optional(),
    }), body);
    const r = await this.auth.verifyOtp({ phone: b.phone, code: b.code, deviceLabel: b.device_label, recovery: b.recovery }, req.ip ?? null, req.header('user-agent') ?? null);
    if (this.isWeb(req)) { this.setCookie(res, r.refresh_token); return { ...r, refresh_token: undefined }; }
    return r;
  }

  @Post('auth/refresh') @Public() @HttpCode(200)
  async refresh(@Body() body: unknown, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const b = parse(z.object({ refresh_token: z.string().min(20).max(200).optional() }), body);
    const token = b.refresh_token ?? (req as any).cookies?.[COOKIE] ?? parseCookie(req.header('cookie'), COOKIE);
    if (!token) throw E.unauthorized('invalid_refresh', 'Session expired. Please sign in again.');
    const pair = await this.auth.refresh(token, req.ip ?? null);
    if (this.isWeb(req)) { this.setCookie(res, pair.refresh_token); return { ...pair, refresh_token: undefined }; }
    return pair;
  }

  @Post('auth/logout') @Auth({ kind: 'user' }) @HttpCode(200)
  async logout(@Me() me: Principal, @Res({ passthrough: true }) res: Response) {
    if (me.kind === 'user') await this.auth.revokeSession(me.userId, me.sessionId, 'logout');
    res.clearCookie(COOKIE, { path: '/v1/auth' });
    return { ok: true };
  }

  // -------- staff two-factor
  @Post('auth/2fa/enroll') @Auth({ kind: 'staff', mfa: false }) @HttpCode(200)
  enroll(@Me() me: Principal) { return this.auth.enrollTotp((me as any).userId); }

  @Post('auth/2fa/verify') @Auth({ kind: 'staff', mfa: false }) @HttpCode(200)
  verifyMfa(@Me() me: Principal, @Body() body: unknown) {
    const b = parse(z.object({ code: z.string().regex(/^\d{6}$/) }), body);
    const u = me as Extract<Principal, { kind: 'user' }>;
    return this.auth.verifyMfa(u.userId, u.sessionId, b.code);
  }

  // -------- device / session management
  @Get('sessions') @Auth({ kind: 'user' })
  async sessions(@Me() me: Principal) {
    const u = me as Extract<Principal, { kind: 'user' }>;
    return { sessions: await this.auth.listSessions(u.userId, u.sessionId) };
  }

  @Delete('sessions/:id') @Auth({ kind: 'user' })
  async revoke(@Me() me: Principal, @Param('id') id: string) {
    const u = me as Extract<Principal, { kind: 'user' }>;
    await this.auth.revokeSession(u.userId, parse(uuid, id));
    return { ok: true };
  }

  @Post('sessions/revoke-others') @Auth({ kind: 'user' }) @HttpCode(200)
  async revokeOthers(@Me() me: Principal) {
    const u = me as Extract<Principal, { kind: 'user' }>;
    return { revoked: await this.auth.revokeAll(u.userId, u.sessionId) };
  }
}

function parseCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return undefined;
}
