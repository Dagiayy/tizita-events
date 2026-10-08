import { Body, Controller, Get, Headers, HttpCode, Param, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { Auth, Me, Public } from '../auth/auth.guard';
import { Principal } from '../common/request-context';
import { parse, uuid } from '../common/zod.pipe';
import { ExportsService } from './exports.service';

@Controller('v1')
export class ExportsController {
  constructor(private readonly exports: ExportsService) {}

  @Post('events/:id/exports') @Auth({ kind: 'user' }) @HttpCode(200)
  create(@Me() me: Principal, @Param('id') id: string, @Body() body: unknown, @Headers('idempotency-key') idem?: string) { return this.exports.create(me, parse(uuid, id), body, idem); }

  @Get('events/:id/exports') @Auth({ kind: 'user' })
  list(@Me() me: Principal, @Param('id') id: string) { return this.exports.listForEvent(me, parse(uuid, id)); }

  @Get('exports/:id/status') @Auth({ kind: 'user' })
  status(@Me() me: Principal, @Param('id') id: string) { return this.exports.status(me, parse(uuid, id)); }

  @Get('exports/:id/download') @Auth({ kind: 'user' })
  download(@Me() me: Principal, @Param('id') id: string) { return this.exports.downloadLink(me, parse(uuid, id)); }

  @Get('exports/:id/file') @Public()
  async file(@Param('id') id: string, @Query('exp') exp: string, @Query('sig') sig: string, @Res() res: Response) { await this.exports.streamFile(parse(uuid, id), exp, sig, res); }
}
