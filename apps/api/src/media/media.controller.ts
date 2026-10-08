import { Body, Controller, Delete, Get, Headers, HttpCode, Param, Patch, Post, Put, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { Auth, Me, Public } from '../auth/auth.guard';
import { E } from '../common/errors';
import { Principal } from '../common/request-context';
import { parse, uuid } from '../common/zod.pipe';
import { GalleryService, HOST_FILTERS } from '../gallery/gallery.service';
import { RealtimeService } from '../gallery/realtime.service';
import { ModerationService } from '../moderation/moderation.service';
import { MediaServeService } from './media-serve.service';
import { UploadService } from './upload.service';

const id = (v: string) => parse(uuid, v);
const reasonSchema = z.object({ reason: z.string().trim().max(300).optional() });

@Controller('v1')
export class MediaController {
  constructor(
    private readonly uploads: UploadService,
    private readonly gallery: GalleryService,
    private readonly moderation: ModerationService,
    private readonly serve: MediaServeService,
    private readonly realtime: RealtimeService,
  ) {}

  // ------------------------------------------------------------------ upload intents + chunk gateway
  @Post('events/:id/uploads/intents') @Auth({ kind: 'user' }) @HttpCode(200)
  memberIntent(@Me() me: Principal, @Param('id') eid: string, @Body() body: unknown, @Headers('idempotency-key') idem?: string) {
    return this.uploads.createIntent(me, id(eid), body, idem);
  }

  @Post('guest/uploads/intents') @Auth({ kind: 'guest', scope: 'upload' }) @HttpCode(200)
  guestIntent(@Me() me: Principal, @Body() body: unknown, @Headers('idempotency-key') idem?: string) {
    return this.uploads.createIntent(me, null, body, idem);
  }

  @Put('uploads/:id/chunks/:n') @Public() @HttpCode(200)
  chunk(@Param('id') mid: string, @Param('n') n: string, @Headers('x-upload-token') token: string | undefined, @Req() req: Request) {
    return this.uploads.putChunk(id(mid), Number(n), token, Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0));
  }

  @Get('uploads/:id') @Public()
  status(@Param('id') mid: string, @Headers('x-upload-token') token?: string) { return this.uploads.status(id(mid), token); }

  @Delete('uploads/:id') @Public()
  cancel(@Param('id') mid: string, @Headers('x-upload-token') token?: string) { return this.uploads.cancel(id(mid), token); }

  @Post('media/:id/complete') @Public() @HttpCode(200)
  complete(@Param('id') mid: string, @Headers('x-upload-token') token?: string, @Headers('idempotency-key') idem?: string) {
    return this.uploads.complete(id(mid), token, idem);
  }

  // ------------------------------------------------------------------ guest gallery
  @Get('guest/media') @Auth({ kind: 'guest', scope: 'gallery' })
  guestMedia(@Me() me: Principal, @Query() q: Record<string, string>) {
    return this.gallery.listForGuest(me, { cursor: q.cursor, limit: q.limit ? Number(q.limit) : undefined, folder_id: q.folder_id ? id(q.folder_id) : undefined, highlights: q.highlights === 'true', sender: q.sender, mine: q.mine === 'true' });
  }

  @Get('guest/senders') @Auth({ kind: 'guest', scope: 'gallery' })
  guestSenders(@Me() me: Principal) { return this.gallery.guestSenders(me); }

  @Get('guest/folders') @Auth({ kind: 'guest', scope: 'gallery' })
  guestFolders(@Me() me: Principal) { return this.gallery.guestFolders(me); }

  @Get('guest/media/:id/download-link') @Auth({ kind: 'guest', scope: 'gallery' })
  downloadLink(@Me() me: Principal, @Param('id') mid: string, @Query('variant') variant?: string) {
    return this.gallery.downloadLink(me, id(mid), variant === 'original' ? 'original' : 'viewer');
  }

  @Delete('guest/media/:id') @Auth({ kind: 'guest' })
  guestDelete(@Me() me: Principal, @Param('id') mid: string) { return this.moderation.guestDelete(me, id(mid)); }

  @Post('guest/live-ticket') @Auth({ kind: 'guest', scope: 'gallery' }) @HttpCode(200)
  guestTicket(@Me() me: Principal) { return this.gallery.liveTicket(me); }

  @Get('live') @Public()
  async live(@Query('ticket') ticket: string, @Res() res: Response) {
    if (!ticket || ticket.length > 100) throw E.unauthorized('invalid_ticket');
    await this.realtime.open(ticket, res);
  }

  // ------------------------------------------------------------------ report (guest or member)
  @Post('media/:id/report') @Auth({ kind: 'user_or_guest' }) @HttpCode(200)
  report(@Me() me: Principal, @Param('id') mid: string, @Body() body: unknown) { return this.moderation.report(me, id(mid), body); }

  // ------------------------------------------------------------------ host gallery management
  @Get('events/:id/media-senders') @Auth({ kind: 'user' })
  hostSenders(@Me() me: Principal, @Param('id') eid: string) { return this.gallery.memberSenders(me, id(eid)); }

  @Get('events/:id/media') @Auth({ kind: 'user' })
  hostMedia(@Me() me: Principal, @Param('id') eid: string, @Query() q: Record<string, string>) {
    const filter = q.filter && (HOST_FILTERS as readonly string[]).includes(q.filter) ? (q.filter as (typeof HOST_FILTERS)[number]) : 'newest';
    return this.gallery.listForMember(me, id(eid), { filter, folder_id: q.folder_id ? id(q.folder_id) : undefined, sender: q.sender, cursor: q.cursor, limit: q.limit ? Number(q.limit) : undefined });
  }

  @Patch('media/:id') @Auth({ kind: 'user' })
  patch(@Me() me: Principal, @Param('id') mid: string, @Body() body: unknown) {
    return this.moderation.patchMedia(me, id(mid), parse(z.object({ is_highlight: z.boolean(), folder_id: z.string().uuid().nullable(), caption: z.string().max(300).nullable() }).partial().strict(), body));
  }

  @Get('events/:id/moderation') @Auth({ kind: 'user' })
  queue(@Me() me: Principal, @Param('id') eid: string) { return this.moderation.queue(me, id(eid)); }

  @Post('media/:id/approve') @Auth({ kind: 'user' }) @HttpCode(200)
  approve(@Me() me: Principal, @Param('id') mid: string, @Body() b: unknown) { return this.act(me, mid, 'approve', b); }
  @Post('media/:id/reject') @Auth({ kind: 'user' }) @HttpCode(200)
  reject(@Me() me: Principal, @Param('id') mid: string, @Body() b: unknown) { return this.act(me, mid, 'reject', b); }
  @Post('media/:id/hide') @Auth({ kind: 'user' }) @HttpCode(200)
  hide(@Me() me: Principal, @Param('id') mid: string, @Body() b: unknown) { return this.act(me, mid, 'hide', b); }
  @Post('media/:id/restore') @Auth({ kind: 'user' }) @HttpCode(200)
  restore(@Me() me: Principal, @Param('id') mid: string, @Body() b: unknown) { return this.act(me, mid, 'restore', b); }
  @Delete('media/:id') @Auth({ kind: 'user' })
  remove(@Me() me: Principal, @Param('id') mid: string) { return this.act(me, mid, 'delete', {}); }

  private async act(me: Principal, mid: string, action: 'approve' | 'reject' | 'hide' | 'restore' | 'delete', body: unknown) {
    const r = await this.moderation.act(me, id(mid), action, parse(reasonSchema, body).reason);
    return { id: r.id, moderation_state: r.moderation_state };
  }

  @Post('events/:id/moderation/bulk') @Auth({ kind: 'user' }) @HttpCode(200)
  bulk(@Me() me: Principal, @Param('id') eid: string, @Body() body: unknown) {
    const b = parse(z.object({ action: z.enum(['approve', 'reject', 'hide', 'restore', 'delete']), media_ids: z.array(z.string().uuid()).min(1).max(200), reason: z.string().max(300).optional() }), body);
    return this.moderation.bulk(me, id(eid), b.action, b.media_ids, b.reason);
  }

  @Get('events/:id/reports') @Auth({ kind: 'user' })
  reports(@Me() me: Principal, @Param('id') eid: string, @Query('status') status?: string) { return this.moderation.listReports(me, id(eid), status); }

  @Post('reports/:id/escalate') @Auth({ kind: 'user' }) @HttpCode(200)
  escalate(@Me() me: Principal, @Param('id') rid: string, @Body() body: unknown) { return this.moderation.escalate(me, id(rid), parse(reasonSchema, body).reason); }

  @Get('events/:id/moderation/logs') @Auth({ kind: 'user' })
  logs(@Me() me: Principal, @Param('id') eid: string, @Query('before') before?: string) { return this.moderation.logs(me, id(eid), before); }

  @Post('events/:id/guests/:sid/block') @Auth({ kind: 'user' }) @HttpCode(200)
  block(@Me() me: Principal, @Param('id') eid: string, @Param('sid') sid: string, @Body() body: unknown) {
    return this.moderation.blockUploader(me, id(eid), id(sid), parse(z.object({ hide_media: z.boolean().optional(), reason: z.string().max(300).optional() }), body));
  }

  @Post('media/:id/block-uploader') @Auth({ kind: 'user' }) @HttpCode(200)
  blockByMedia(@Me() me: Principal, @Param('id') mid: string, @Body() body: unknown) {
    return this.moderation.blockUploaderByMedia(me, id(mid), parse(z.object({ hide_media: z.boolean().optional(), reason: z.string().max(300).optional() }), body));
  }

  // ------------------------------------------------------------------ signed media
  @Get('m/:id/:variant') @Public()
  async media(@Param('id') mid: string, @Param('variant') variant: string, @Query() q: Record<string, string>, @Res() res: Response) {
    await this.serve.serve(mid, variant, q, res);
  }

  @Get('c/:code') @Public()
  async cover(@Param('code') code: string, @Query('exp') exp: string, @Query('sig') sig: string, @Res() res: Response) {
    await this.serve.serveCover(code, exp, sig, res);
  }
}
