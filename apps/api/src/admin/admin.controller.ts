import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { AnalyticsService } from '../analytics/analytics.service';
import { AuditService } from '../audit/audit.service';
import { Auth, AuthSpec, Me } from '../auth/auth.guard';
import { AuthService } from '../auth/auth.service';
import { SettingsService } from '../infra/settings.service';
import { randomFromAlphabet } from '../common/crypto';
import { E } from '../common/errors';
import { Principal } from '../common/request-context';
import { parse, uuid } from '../common/zod.pipe';
import { LifecycleService } from '../events/lifecycle.service';
import { Db } from '../infra/db.service';
import { DeletionService } from '../privacy/deletion.service';
import { PrivacyService } from '../privacy/privacy.service';
import { PaymentsService } from '../payments/payments.service';
import { AdminService } from './admin.service';
import { MaintenanceService } from './maintenance.service';

type Staff = Extract<Principal, { kind: 'user' }>;
const S = (me: Principal) => me as Staff;
const id = (v: string) => parse(uuid, v);
const reason = z.string().trim().min(5).max(500);
const totp = z.union([z.string().regex(/^\d{6}$/), z.literal('')]).optional();
const SUPER: AuthSpec = { kind: 'staff', roles: ['super_admin'] };
const ANY: AuthSpec = { kind: 'staff' };

@Controller('v1/admin')
export class AdminController {
  constructor(
    private readonly admin: AdminService, private readonly audit: AuditService, private readonly privacy: PrivacyService, private readonly deletion: DeletionService,
    private readonly payments: PaymentsService, private readonly analytics: AnalyticsService, private readonly maintenance: MaintenanceService, private readonly lifecycle: LifecycleService,
    private readonly auth: AuthService, private readonly settings: SettingsService,
  ) {}

  // ---- dashboard / KPIs
  @Get('dashboard') @Auth(ANY) dashboard() { return this.admin.dashboard(); }
  @Get('kpis') @Auth(ANY) kpis(@Query('days') days?: string) { return this.analytics.platformKpis(Math.min(Number(days) || 30, 365)); }

  // ---- events (metadata only)
  @Get('events') @Auth(ANY)
  events(@Query() q: Record<string, string>) { return this.admin.searchEvents({ code: q.code, owner_phone: q.owner_phone, title: q.title, city: q.city, state: q.state, from: q.from, to: q.to, before: q.before, limit: q.limit ? Number(q.limit) : undefined }); }
  @Get('events/:id') @Auth(ANY) event(@Param('id') eid: string) { return this.admin.eventDetail(id(eid)); }

  @Post('events/:id/suspend') @Auth(SUPER) @HttpCode(200)
  suspend(@Me() me: Principal, @Param('id') eid: string, @Body() b: unknown) { const x = parse(z.object({ reason, totp_code: totp }), b); return this.admin.suspend(S(me), id(eid), x.reason, x.totp_code); }
  @Post('events/:id/unsuspend') @Auth(SUPER) @HttpCode(200)
  unsuspend(@Me() me: Principal, @Param('id') eid: string, @Body() b: unknown) { const x = parse(z.object({ reason, totp_code: totp }), b); return this.admin.unsuspend(S(me), id(eid), x.reason, x.totp_code); }
  @Post('events/:id/archive') @Auth(SUPER) @HttpCode(200)
  archive(@Me() me: Principal, @Param('id') eid: string, @Body() b: unknown) { return this.admin.archive(S(me), id(eid), parse(z.object({ reason }), b).reason); }
  @Post('events/:id/restore') @Auth(SUPER) @HttpCode(200)
  restore(@Me() me: Principal, @Param('id') eid: string, @Body() b: unknown) { return this.admin.restore(S(me), id(eid), parse(z.object({ reason }), b).reason); }
  @Patch('events/:id/ops') @Auth(SUPER)
  ops(@Me() me: Principal, @Param('id') eid: string, @Body() b: unknown) {
    const x = parse(z.object({ reason, changes: z.object({ uploads_enabled: z.boolean(), upload_closes_at: z.string().datetime({ offset: true }), moderation_mode: z.enum(['pre', 'post']), report_hide_threshold: z.number().int().min(1).max(20) }).partial().strict() }), b);
    return this.admin.ops(S(me), id(eid), x.changes, x.reason);
  }
  @Post('events/:id/grant') @Auth(SUPER) @HttpCode(200)
  grant(@Me() me: Principal, @Param('id') eid: string, @Body() b: unknown) { const x = parse(z.object({ plan_code: z.string(), reason, totp_code: totp }), b); return this.admin.grantPlan(S(me), id(eid), x.plan_code, x.reason, x.totp_code); }
  @Post('events/:id/legal-hold') @Auth(SUPER) @HttpCode(200)
  hold(@Me() me: Principal, @Param('id') eid: string, @Body() b: unknown) {
    const x = parse(z.object({ reason, totp_code: totp }), b);
    return this.stepUp(me, x.totp_code).then(() => this.deletion.placeHold(S(me).userId, id(eid), x.reason));
  }
  @Delete('events/:id/legal-hold') @Auth(SUPER)
  release(@Me() me: Principal, @Param('id') eid: string, @Query('reason') r: string, @Query('totp_code') t?: string) {
    return this.stepUp(me, t).then(() => this.deletion.releaseHold(S(me).userId, id(eid), parse(reason, r)));
  }
  private async stepUp(me: Principal, code?: string) { await this.auth.requireStepUp(S(me).userId, code); }

  // ---- elevated media access (four-eyes)
  @Get('media-access') @Auth(ANY) mediaAccess(@Query('state') s?: string) { return this.admin.listMediaAccess(s); }
  @Post('media-access') @Auth(ANY) @HttpCode(200)
  requestAccess(@Me() me: Principal, @Body() b: unknown) { return this.admin.requestMediaAccess(S(me), parse(z.object({ event_id: z.string().uuid(), media_id: z.string().uuid().optional(), reason: z.string().trim().min(10).max(500), ticket_ref: z.string().max(60).optional() }), b)); }
  @Post('media-access/:id/approve') @Auth(SUPER) @HttpCode(200)
  approveAccess(@Me() me: Principal, @Param('id') gid: string, @Body() b: unknown) { const x = parse(z.object({ totp_code: totp, minutes: z.number().int().min(5).max(120).optional() }), b); return this.admin.decideMediaAccess(S(me), id(gid), 'approve', x.totp_code, x.minutes); }
  @Post('media-access/:id/deny') @Auth(SUPER) @HttpCode(200)
  denyAccess(@Me() me: Principal, @Param('id') gid: string) { return this.admin.decideMediaAccess(S(me), id(gid), 'deny'); }
  @Post('media-access/:id/revoke') @Auth(SUPER) @HttpCode(200)
  revokeAccess(@Me() me: Principal, @Param('id') gid: string) { return this.admin.decideMediaAccess(S(me), id(gid), 'revoke'); }
  @Get('media-access/:id/media') @Auth(ANY) accessMedia(@Me() me: Principal, @Param('id') gid: string) { return this.admin.mediaForGrant(S(me), id(gid)); }

  // ---- moderation
  @Get('moderation/reports') @Auth(ANY) reports(@Query('status') s?: string) { return this.admin.reports(s); }
  @Get('moderation/signals') @Auth(ANY) signals() { return this.admin.blockedAndSpikes(); }
  @Post('moderation/media/:id/action') @Auth(ANY) @HttpCode(200)
  mediaAction(@Me() me: Principal, @Param('id') mid: string, @Body() b: unknown) { const x = parse(z.object({ action: z.enum(['hide', 'reject', 'delete', 'restore']), reason }), b); return this.admin.platformAction(S(me), id(mid), x.action, x.reason); }

  // ---- organizations, users, support
  @Get('organizations') @Auth(ANY) orgs() { return this.admin.organizations(); }
  @Post('organizations') @Auth(SUPER) @HttpCode(200)
  createOrg(@Me() me: Principal, @Body() b: unknown) { return this.admin.createOrganization(S(me), parse(z.object({ legal_name: z.string().min(2).max(200), tin: z.string().max(40).optional(), owner_phone: z.string().max(20).optional() }), b)); }
  @Patch('organizations/:id/verification') @Auth(SUPER)
  verifyOrg(@Me() me: Principal, @Param('id') oid: string, @Body() b: unknown) { const x = parse(z.object({ state: z.enum(['unverified', 'pending', 'verified', 'rejected']), reason }), b); return this.admin.setOrganizationVerification(S(me), id(oid), x.state, x.reason); }
  @Get('users') @Auth(ANY) users(@Query('phone') phone?: string) { return this.admin.users({ phone }); }
  @Post('users/:id/status') @Auth(SUPER) @HttpCode(200)
  userStatus(@Me() me: Principal, @Param('id') uid: string, @Body() b: unknown) { const x = parse(z.object({ status: z.enum(['active', 'suspended']), reason, totp_code: totp }), b); return this.admin.setUserStatus(S(me), id(uid), x.status, x.reason, x.totp_code); }
  @Get('support/tickets') @Auth(ANY) tickets(@Query('status') s?: string) { return this.admin.tickets(s); }
  @Patch('support/tickets/:id') @Auth(ANY)
  ticket(@Me() me: Principal, @Param('id') tid: string, @Body() b: unknown) { return this.admin.updateTicket(S(me), id(tid), parse(z.object({ status: z.enum(['open', 'pending', 'resolved', 'closed']).optional(), assign_to_me: z.boolean().optional() }), b)); }

  // ---- storage
  @Get('storage') @Auth(ANY) storage() { return this.admin.storageOverview(); }
  @Post('storage/orphan-scan') @Auth(SUPER) @HttpCode(200)
  orphan(@Body() b: unknown) { return this.admin.orphanScan(!!parse(z.object({ remove: z.boolean().optional() }), b).remove); }

  // ---- payments
  @Get('payments/orders') @Auth(ANY) orders(@Query() q: Record<string, string>) { return this.admin.orders({ state: q.state, provider: q.provider }); }
  @Get('payments/callbacks') @Auth(ANY) callbacks(@Query('order_ref') r?: string) { return this.admin.callbacks(r); }
  @Get('payments/reconciliation') @Auth(ANY) recon() { return this.admin.reconciliationRuns(); }
  @Post('payments/reconcile') @Auth(SUPER) @HttpCode(200) reconcile() { return this.payments.reconcile(); }
  @Get('payments/refunds') @Auth(ANY) refunds() { return this.admin.refunds(); }
  @Get('payments/invoices') @Auth(ANY) invoices() { return this.admin.invoices(); }
  @Post('payments/orders/:id/refund') @Auth(SUPER) @HttpCode(200)
  async refund(@Me() me: Principal, @Param('id') oid: string, @Body() b: unknown) {
    const x = parse(z.object({ amount_etb: z.number().positive().optional(), reason, totp_code: totp }), b);
    await this.stepUp(me, x.totp_code);
    return this.payments.requestRefund(S(me).userId, id(oid), x.amount_etb, x.reason);
  }
  @Post('payments/refunds/:id/confirm') @Auth(SUPER) @HttpCode(200)
  async confirmRefund(@Me() me: Principal, @Param('id') rid: string, @Body() b: unknown) {
    const x = parse(z.object({ provider_refund_ref: z.string().min(3).max(120), totp_code: totp }), b);
    await this.stepUp(me, x.totp_code);
    return this.payments.confirmRefund(S(me).userId, id(rid), x.provider_refund_ref);
  }
  @Post('payments/refunds/:id/fail') @Auth(SUPER) @HttpCode(200)
  failRefund(@Me() me: Principal, @Param('id') rid: string, @Body() b: unknown) { return this.payments.failRefund(S(me).userId, id(rid), parse(z.object({ note: reason }), b).note); }

  // ---- compliance
  @Get('compliance/rights-requests') @Auth(ANY) rights(@Query('state') s?: string, @Query('overdue') o?: string) { return this.privacy.list({ state: s, overdue: o === 'true' }); }
  @Post('compliance/rights-requests/:id/advance') @Auth(ANY) @HttpCode(200)
  advance(@Me() me: Principal, @Param('id') rid: string, @Body() b: unknown) {
    const x = parse(z.object({ to: z.enum(['identity_verification', 'in_progress', 'completed', 'rejected']), note: z.string().max(1000).optional(), actions: z.object({ delete_media: z.boolean().optional(), erase_guest_session: z.boolean().optional(), erase_user: z.boolean().optional() }).optional() }), b);
    if (x.actions && S(me).platformRole !== 'super_admin') throw E.forbidden('insufficient_role', 'Only a super admin can execute erasure actions.');
    return this.privacy.advance(S(me).userId, id(rid), x.to, x.note, x.actions);
  }
  @Get('compliance/rights-requests/:id/access-report') @Auth(SUPER) accessReport(@Me() me: Principal, @Param('id') rid: string) { return this.privacy.accessReport(S(me).userId, id(rid)); }
  @Get('compliance/consents') @Auth(ANY) consents(@Query('event_id') e?: string) { return this.admin.consents({ event_id: e }); }
  @Get('compliance/deletion-jobs') @Auth(ANY) jobs(@Query('status') s?: string) { return this.admin.deletionJobs(s); }
  @Post('compliance/deletion-jobs/:id/run') @Auth(SUPER) @HttpCode(200)
  async runJob(@Me() me: Principal, @Param('id') jid: string, @Body() b: unknown) { await this.stepUp(me, parse(z.object({ totp_code: totp }), b).totp_code); return this.deletion.run(id(jid)); }
  @Get('compliance/incidents') @Auth(ANY) incidents(@Query('state') s?: string) { return this.admin.incidents(s); }
  @Get('compliance/incidents/:id') @Auth(ANY) incident(@Param('id') iid: string) { return this.admin.incident(id(iid)); }
  @Post('compliance/incidents') @Auth(ANY) @HttpCode(200)
  createIncident(@Me() me: Principal, @Body() b: unknown) {
    return this.admin.createIncident(S(me), parse(z.object({
      kind: z.enum(['security', 'personal_data_breach', 'abuse', 'operational', 'criminal_content']), severity: z.enum(['low', 'medium', 'high', 'critical']), title: z.string().min(3).max(200), description: z.string().max(4000).optional(),
      event_id: z.string().uuid().optional(), discovered_at: z.string().datetime({ offset: true }), data_categories: z.array(z.string().max(60)).max(20).optional(),
      approx_subjects: z.number().int().min(0).optional(), approx_records: z.number().int().min(0).optional(), commander_id: z.string().uuid().optional(),
    }), b));
  }
  @Patch('compliance/incidents/:id') @Auth(ANY)
  updateIncident(@Me() me: Principal, @Param('id') iid: string, @Body() b: unknown) {
    return this.admin.updateIncident(S(me), id(iid), parse(z.object({
      state: z.enum(['open', 'contained', 'notified', 'resolved', 'closed']).optional(), regulator_notified_at: z.string().datetime({ offset: true }).optional(), subjects_notified_at: z.string().datetime({ offset: true }).optional(),
      postmortem: z.string().max(8000).optional(), severity: z.enum(['low', 'medium', 'high', 'critical']).optional(), entry: z.string().max(2000).optional(),
    }), b));
  }
  @Get('compliance/vendors') @Auth(ANY) vendors() { return this.admin.vendors(); }
  @Put('compliance/vendors') @Auth(SUPER)
  vendor(@Me() me: Principal, @Body() b: unknown) {
    return this.admin.upsertVendor(S(me), parse(z.object({
      name: z.string().min(2).max(160), purpose: z.string().min(2).max(300), data_categories: z.array(z.string()).max(30).optional(), data_location: z.string().min(2).max(160), outside_ethiopia: z.boolean().optional(),
      subprocessors: z.string().max(500).optional(), retention: z.string().max(300).optional(), dpa_signed: z.boolean().optional(), transfer_assessment_ref: z.string().max(120).optional(), breach_contact: z.string().max(200).optional(),
      status: z.enum(['planned', 'active', 'suspended', 'retired']).optional(),
    }), b));
  }

  // ---- audit
  @Get('audit') @Auth(ANY)
  auditLog(@Query() q: Record<string, string>) { return this.audit.search({ actorId: q.actor_id, action: q.action, resourceType: q.resource_type, resourceId: q.resource_id, eventId: q.event_id, before: q.before ? Number(q.before) : undefined, limit: q.limit ? Number(q.limit) : undefined }); }
  @Get('audit/verify') @Auth(SUPER) verifyAudit() { return this.audit.verifyChain(); }

  // ---- configuration & catalogue
  @Get('settings') @Auth(ANY) settingsList() { return this.settings.list(); }
  @Put('settings/:key') @Auth(SUPER)
  setSetting(@Me() me: Principal, @Param('key') key: string, @Body() b: unknown) { const x = parse(z.object({ value: z.any(), reason, totp_code: totp }), b); return this.admin.setSetting(S(me), key, x.value, x.reason, x.totp_code); }
  @Get('plans') @Auth(ANY) plans() { return this.admin.plans(); }
  @Patch('plans/:code') @Auth(SUPER)
  plan(@Me() me: Principal, @Param('code') code: string, @Body() b: unknown) { const x = parse(z.object({ totp_code: totp }).passthrough(), b) as any; const { totp_code, ...rest } = x; return this.admin.upsertPlan(S(me), code, rest, totp_code); }

  // ---- operations
  @Post('ops/lifecycle-tick') @Auth(SUPER) @HttpCode(200) tick() { return this.lifecycle.tick(); }
  @Post('ops/maintenance') @Auth(SUPER) @HttpCode(200) maint() { return this.maintenance.runAll(); }
}

/** Host-facing support entry (journey H). */
@Controller('v1/support')
export class SupportController {
  constructor(private readonly db: Db, private readonly audit: AuditService) {}

  @Post('tickets') @Auth({ kind: 'user' }) @HttpCode(200)
  async create(@Me() me: Principal, @Body() b: unknown) {
    const x = parse(z.object({ category: z.enum(['general', 'payment', 'refund', 'access', 'abuse', 'privacy']).default('general'), subject: z.string().trim().min(3).max(160), body: z.string().trim().min(5).max(4000), event_id: z.string().uuid().optional() }), b);
    const u = me as Staff;
    if (x.event_id) {
      const m = await this.db.one('SELECT 1 FROM event_members WHERE event_id = $1 AND user_id = $2 AND status = \'active\'', [x.event_id, u.userId]);
      if (!m) throw E.notFound('event_not_found');
    }
    const ref = 'TKT-' + randomFromAlphabet('ABCDEFGHJKMNPQRSTUVWXYZ23456789', 8);
    const t = await this.db.one<any>('INSERT INTO support_tickets (ref, user_id, event_id, category, subject, body) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, ref, status, created_at', [ref, u.userId, x.event_id ?? null, x.category, x.subject, x.body]);
    await this.audit.record({ action: 'support.ticket_created', resourceType: 'support_ticket', resourceId: t.id, eventId: x.event_id ?? null, after: { category: x.category } });
    return t;
  }

  @Get('tickets') @Auth({ kind: 'user' })
  mine(@Me() me: Principal) { return this.db.many('SELECT id, ref, category, subject, status, created_at FROM support_tickets WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50', [(me as Staff).userId]); }
}
void randomUUID;
