import { Body, Controller, Get, Headers, HttpCode, Param, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { Me, Public } from '../auth/auth.guard';
import { Principal } from '../common/request-context';
import { PrivacyService } from './privacy.service';

@Controller('v1')
export class PrivacyController {
  constructor(private readonly privacy: PrivacyService) {}

  /** Anyone can file a request (guests, hosts, people photographed). A guest/host bearer token links the request automatically. */
  @Post('privacy/requests') @Public() @HttpCode(200)
  create(@Me() me: Principal, @Body() body: unknown, @Req() req: Request) { return this.privacy.create(me, body, req.ip ?? null); }

  @Get('privacy/requests/:ref') @Public()
  inspect(@Param('ref') ref: string, @Headers('x-request-token') token?: string) { return this.privacy.inspect(ref, token); }

  @Get('policies/:kind') @Public()
  policy(@Param('kind') kind: string, @Query('lang') lang?: string) { return this.privacy.policy(kind, lang ?? 'en'); }
}
