import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service';
import { Auth, Me } from '../auth/auth.guard';
import { E } from '../common/errors';
import { Principal } from '../common/request-context';
import { parse, uuid } from '../common/zod.pipe';
import { AccessService } from './access.service';
import { EventsService } from './events.service';
import { SharingService } from './sharing.service';
import { RealtimeService } from '../gallery/realtime.service';

const id = (v: string) => parse(uuid, v);

@Controller('v1')
export class EventsController {
  constructor(
    private readonly events: EventsService,
    private readonly sharing: SharingService,
    private readonly access: AccessService,
    private readonly realtime: RealtimeService,
    private readonly audit: AuditService,
  ) {}

  @Post('events') @Auth({ kind: 'user' })
  create(@Me() me: Principal, @Body() body: unknown) { return this.events.create(me, body); }

  @Get('events') @Auth({ kind: 'user' })
  list(@Me() me: Principal) { return this.events.list(me); }

  @Get('events/:id') @Auth({ kind: 'user' })
  get(@Me() me: Principal, @Param('id') eid: string) { return this.events.get(me, id(eid)); }

  @Patch('events/:id') @Auth({ kind: 'user' })
  update(@Me() me: Principal, @Param('id') eid: string, @Body() body: unknown) { return this.events.update(me, id(eid), body); }

  @Post('events/:id/close') @Auth({ kind: 'user' }) @HttpCode(200)
  close(@Me() me: Principal, @Param('id') eid: string, @Body() body: unknown) {
    return this.events.close(me, id(eid), parse(z.object({ mode: z.enum(['now', 'schedule']), at: z.string().datetime({ offset: true }).optional() }), body));
  }

  @Post('events/:id/extend') @Auth({ kind: 'user' }) @HttpCode(200)
  extend(@Me() me: Principal, @Param('id') eid: string, @Body() body: unknown) {
    return this.events.extend(me, id(eid), parse(z.object({ upload_closes_at: z.string().datetime({ offset: true }) }), body).upload_closes_at);
  }

  @Post('events/:id/archive') @Auth({ kind: 'user' }) @HttpCode(200)
  archive(@Me() me: Principal, @Param('id') eid: string) { return this.events.archive(me, id(eid)); }

  @Post('events/:id/restore') @Auth({ kind: 'user' }) @HttpCode(200)
  restore(@Me() me: Principal, @Param('id') eid: string) { return this.events.restore(me, id(eid)); }

  @Post('events/:id/delete') @Auth({ kind: 'user' }) @HttpCode(200)
  del(@Me() me: Principal, @Param('id') eid: string, @Body() body: unknown) {
    return this.events.requestDeletion(me, id(eid), parse(z.object({ confirm_name: z.string().min(1).max(120) }), body).confirm_name);
  }

  @Post('events/:id/cancel-deletion') @Auth({ kind: 'user' }) @HttpCode(200)
  cancelDeletion(@Me() me: Principal, @Param('id') eid: string) { return this.events.cancelDeletion(me, id(eid)); }

  // ---- team
  @Get('events/:id/members') @Auth({ kind: 'user' })
  members(@Me() me: Principal, @Param('id') eid: string) { return this.events.listMembers(me, id(eid)); }

  @Post('events/:id/members') @Auth({ kind: 'user' }) @HttpCode(200)
  invite(@Me() me: Principal, @Param('id') eid: string, @Body() body: unknown) {
    return this.events.inviteMember(me, id(eid), parse(z.object({ phone: z.string().min(5).max(20), role: z.enum(['moderator', 'photographer']) }), body));
  }

  @Delete('events/:id/members/:memberId') @Auth({ kind: 'user' })
  removeMember(@Me() me: Principal, @Param('id') eid: string, @Param('memberId') mid: string) { return this.events.removeMember(me, id(eid), id(mid)); }

  // ---- folders
  @Get('events/:id/folders') @Auth({ kind: 'user' })
  folders(@Me() me: Principal, @Param('id') eid: string) { return this.events.listFolders(me, id(eid)); }

  @Post('events/:id/folders') @Auth({ kind: 'user' }) @HttpCode(200)
  createFolder(@Me() me: Principal, @Param('id') eid: string, @Body() body: unknown) {
    return this.events.createFolder(me, id(eid), parse(z.object({
      name: z.string().trim().min(1).max(80), kind: z.enum(['pre_event', 'ceremony', 'reception', 'highlights', 'custom']).optional(),
      publication_state: z.enum(['draft', 'published']).optional(), download_allowed: z.boolean().optional(), watermark: z.boolean().optional(),
    }), body));
  }

  @Patch('folders/:id') @Auth({ kind: 'user' })
  updateFolder(@Me() me: Principal, @Param('id') fid: string, @Body() body: unknown) {
    return this.events.updateFolder(me, id(fid), parse(z.object({
      name: z.string().trim().min(1).max(80), publication_state: z.enum(['draft', 'published']), download_allowed: z.boolean(), watermark: z.boolean(),
      cover_media_id: z.string().uuid().nullable(), sort_order: z.number().int().min(0).max(1000),
    }).partial().strict(), body));
  }

  @Delete('folders/:id') @Auth({ kind: 'user' })
  deleteFolder(@Me() me: Principal, @Param('id') fid: string) { return this.events.deleteFolder(me, id(fid)); }

  // ---- cover, insights
  @Put('events/:id/cover') @Auth({ kind: 'user' })
  cover(@Me() me: Principal, @Param('id') eid: string, @Req() req: Request) {
    if (!Buffer.isBuffer(req.body) || !req.body.length) throw E.badRequest('image_required', 'Send the image as the request body (Content-Type: image/jpeg|png|webp).');
    return this.events.setCover(me, id(eid), req.body);
  }

  @Get('events/:id/insights') @Auth({ kind: 'user' })
  insights(@Me() me: Principal, @Param('id') eid: string) { return this.events.insights(me, id(eid)); }

  // ---- sharing
  @Get('events/:id/share-links') @Auth({ kind: 'user' })
  shareLinks(@Me() me: Principal, @Param('id') eid: string) { return this.sharing.shareLinks(me, id(eid)); }

  @Post('events/:id/qr') @Auth({ kind: 'user' }) @HttpCode(200)
  async qr(@Me() me: Principal, @Param('id') eid: string, @Body() body: unknown, @Res() res: Response) {
    const b = parse(z.object({ kind: z.enum(['upload', 'gallery']), format: z.enum(['png', 'pdf']).default('png'), include_code: z.boolean().optional(), size: z.number().int().min(256).max(2000).optional() }), body);
    const out = await this.sharing.qr(me, id(eid), b);
    res.setHeader('Content-Type', out.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${out.filename}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.end(out.body);
  }

  @Post('events/:id/secrets/rotate') @Auth({ kind: 'user' }) @HttpCode(200)
  rotate(@Me() me: Principal, @Param('id') eid: string, @Body() body: unknown) {
    return this.sharing.rotate(me, id(eid), parse(z.object({
      type: z.enum(['upload_token', 'gallery_token', 'join_code', 'passcode']), passcode: z.string().min(4).max(64).optional(), revoke_sessions: z.boolean().optional(),
    }), body));
  }

  @Post('events/:id/live-ticket') @Auth({ kind: 'user' }) @HttpCode(200)
  async liveTicket(@Me() me: Principal, @Param('id') eid: string) {
    const { event } = await this.access.requireMember(me, id(eid), 'media.view_all');
    return this.realtime.issueTicket(event.id, 'staff', (me as any).userId);
  }
}
