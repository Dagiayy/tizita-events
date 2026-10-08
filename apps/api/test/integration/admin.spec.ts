import { Client_, Harness, Staff, bootHarness, createEvent, guestUpload, joinAsGuest, nextPhone, photo } from '../helpers/harness';
import { SignedUrlService } from '../../src/media/signed-url.service';
import { normalizeEthiopianPhone } from '../../src/common/phone';
import { AuditService } from '../../src/audit/audit.service';
import { MemorySmsProvider } from '../../src/notifications/notifications.service';

let h: Harness;
beforeAll(async () => { h = await bootHarness(); });
afterAll(async () => { await h.close(); });

describe('Staff authentication: 2FA is mandatory', () => {
  it('OTP alone is not enough for staff; routes need MFA; non-staff are refused; roles are enforced', async () => {
    const phone = nextPhone(); const e = normalizeEthiopianPhone(phone)!;
    await h.db.query(`INSERT INTO users (phone_hash, phone_enc, phone_last4, platform_role) VALUES ($1,$2,$3,'super_admin')`, [h.crypto.hmac(e, 'phone'), h.crypto.encrypt(e), e.slice(-4)]);
    await h.http().post('/v1/auth/request-otp').send({ phone }).expect(200);
    const login = await h.http().post('/v1/auth/verify-otp').send({ phone, code: MemorySmsProvider.lastCode(e) }).expect(200);
    expect(login.body).toMatchObject({ mfa_required: true, mfa_enrolled: false });
    const t = login.body.access_token;
    const blocked = await h.http().get('/v1/admin/dashboard').set('Authorization', `Bearer ${t}`);
    expect(blocked.status).toBe(403); expect(blocked.body.error.code).toBe('mfa_required');
    const enr = await h.http().post('/v1/auth/2fa/enroll').set('Authorization', `Bearer ${t}`).expect(200);
    expect(enr.body.otpauth_uri).toMatch(/^otpauth:\/\/totp\//);
    await h.http().post('/v1/auth/2fa/verify').set('Authorization', `Bearer ${t}`).send({ code: '000000' }).expect(401);
    const secretRow = await h.db.one<any>('SELECT totp_secret_enc FROM users WHERE phone_last4 = $1 AND platform_role = \'super_admin\'', [e.slice(-4)]);
    expect(secretRow.totp_secret_enc).not.toContain(enr.body.secret);                              // secret encrypted at rest
    const staff = await Staff.create(h, 'super_admin');
    await staff.get('/v1/admin/dashboard').expect(200);
    await staff.post('/v1/auth/2fa/enroll').expect(409);                                           // cannot silently re-enrol

    const host = await Client_.host(h);
    await host.get('/v1/admin/dashboard').expect(403);                                             // normal users are not staff
    await h.http().get('/v1/admin/dashboard').expect(401);
    const support = await Staff.create(h, 'support_agent');
    await support.get('/v1/admin/dashboard').expect(200);
    for (const [m, u] of [['post', '/v1/admin/events/00000000-0000-4000-8000-000000000000/suspend'], ['put', '/v1/admin/settings/maintenance.mode'], ['post', '/v1/admin/organizations'], ['get', '/v1/admin/audit/verify'], ['post', '/v1/admin/storage/orphan-scan']] as const)
      expect((await (support as any)[m](u, {})).status).toBe(403);                                  // super-admin-only
  });

  it('TOTP codes are single-use (replay protection)', async () => {
    const s = await Staff.create(h, 'super_admin');
    const ev = await createEvent(h, await Client_.host(h));
    const code = await s.totp();
    await s.post(`/v1/admin/events/${ev.id}/suspend`, { reason: 'abuse report 1', totp_code: code }).expect(200);
    await s.post(`/v1/admin/events/${ev.id}/unsuspend`, { reason: 'cleared after review', totp_code: code }).expect(403);   // same code replayed
  });
});

describe('Admin sees metadata, never media by default (acceptance #14)', () => {
  it('search by code / owner phone / title / city / date / state returns high-level metadata only', async () => {
    const hostPhone = '0933445566';
    const host = await Client_.host(h, hostPhone);
    const ev = await createEvent(h, host, { name: 'የሰላም ሰርግ Wedding', city: 'Hawassa' });
    const g = (await joinAsGuest(h, ev.uploadToken, { code: ev.joinCode, display_name: 'Guest Name' })).body;
    const up = await guestUpload(h, g, await photo(1));
    const other = await createEvent(h, await Client_.host(h), { name: 'Other', city: 'Mekelle' });
    const admin = await Staff.create(h, 'support_agent');
    const q = async (qs: string) => (await admin.get(`/v1/admin/events?${qs}`).expect(200)).body.events;
    expect((await q(`code=${ev.code}`)).map((e: any) => e.id)).toEqual([ev.id]);
    expect((await q(`owner_phone=${encodeURIComponent(hostPhone)}`)).map((e: any) => e.id)).toEqual([ev.id]);
    expect((await q(`title=${encodeURIComponent('ሰላም')}`)).map((e: any) => e.id)).toEqual([ev.id]);      // Ethiopic search
    expect((await q('city=hawassa')).map((e: any) => e.id)).toEqual([ev.id]);
    expect((await q('state=live')).map((e: any) => e.id)).toEqual(expect.arrayContaining([ev.id]));
    const windowed = (await q(`from=${new Date(Date.now() - 86400_000).toISOString()}&to=${new Date(Date.now() + 86400_000).toISOString()}&title=Wedding`)).map((e: any) => e.id);
    expect(windowed).toContain(ev.id);
    expect((await q(`from=${new Date(Date.now() + 10 * 86400_000).toISOString()}`)).map((e: any) => e.id)).not.toContain(ev.id);
    await admin.get('/v1/admin/events?owner_phone=123').expect(400);
    const list = await q(`code=${ev.code}`);
    expect(Object.keys(list[0]).sort()).toEqual(['city', 'created_at', 'id', 'legal_hold', 'media_count', 'name', 'owner_phone_last4', 'public_code', 'starts_at', 'state', 'storage_bytes', 'type']);
    expect(list[0].owner_phone_last4).toBe('5566');
    const detail = (await admin.get(`/v1/admin/events/${ev.id}`).expect(200)).body;
    const raw = JSON.stringify(detail);
    for (const secret of [ev.uploadToken, ev.galleryToken, ev.joinCode, 'Guest Name', up.mediaId!, '0933445566', '933445566']) expect(raw).not.toContain(secret);
    expect(detail.media_access).toBe('requires_grant'); expect(detail.usage.media_count).toBe(1);
    // no content endpoint exists for staff, and staff-audience URLs do not work for them
    await admin.get(`/v1/events/${ev.id}/media`).expect(404);                                       // host API gives staff no implicit membership
    const sig = h.get<SignedUrlService>(SignedUrlService);
    await h.http().get(sig.mediaUrl(up.mediaId!, 'viewer', 'adm').replace('http://localhost:4000', '')).expect(403);              // adm audience without a grant
    void other;
  });

  it('elevated media access: reasoned request, different super admin approves with 2FA, time-boxed, scoped, every view audited', async () => {
    const host = await Client_.host(h);
    const ev = await createEvent(h, host); const evB = await createEvent(h, await Client_.host(h));
    const g = (await joinAsGuest(h, ev.uploadToken, { code: ev.joinCode })).body;
    const m = await guestUpload(h, g, await photo(9));
    const gB = (await joinAsGuest(h, evB.uploadToken, { code: evB.joinCode })).body;
    const mB = await guestUpload(h, gB, await photo(10));
    const support = await Staff.create(h, 'support_agent'); const boss1 = await Staff.create(h, 'super_admin'); const boss2 = await Staff.create(h, 'super_admin');
    await support.post('/v1/admin/media-access', { event_id: ev.id, reason: 'x' }).expect(400);                                     // reason too short
    const grant = (await support.post('/v1/admin/media-access', { event_id: ev.id, reason: 'Host reported missing photo - ticket TKT-1234', ticket_ref: 'TKT-1234' }).expect(200)).body;
    expect(grant.state).toBe('requested');
    await support.get(`/v1/admin/media-access/${grant.id}/media`).expect(403);                                                      // not approved yet
    await support.post(`/v1/admin/media-access/${grant.id}/approve`, { totp_code: await support.totp() }).expect(403);              // support agents cannot approve
    const selfReq = (await boss1.post('/v1/admin/media-access', { event_id: ev.id, reason: 'Investigating abuse report #77' }).expect(200)).body;
    const selfApprove = await boss1.post(`/v1/admin/media-access/${selfReq.id}/approve`, { totp_code: await boss1.totp() });
    expect(selfApprove.status).toBe(403); expect(selfApprove.body.error.code).toBe('self_approval_not_allowed');
    await boss2.post(`/v1/admin/media-access/${grant.id}/approve`, { totp_code: '123456' }).expect(403);                            // step-up must be valid
    const ap = await boss2.post(`/v1/admin/media-access/${grant.id}/approve`, { totp_code: await boss2.totp(), minutes: 15 }).expect(200);
    expect(ap.body.state).toBe('approved');
    expect(new Date(ap.body.expires_at).getTime() - Date.now()).toBeLessThanOrEqual(15 * 60_000 + 2000);
    const view = (await support.get(`/v1/admin/media-access/${grant.id}/media`).expect(200)).body;
    expect(view.items).toHaveLength(1); expect(view.items[0].id).toBe(m.mediaId);
    const img = await h.http().get(view.items[0].urls.viewer.replace('http://localhost:4000', '')).expect(200);
    expect(img.headers['cache-control']).toMatch(/no-store/);
    // scope: another event's media cannot be fetched with this grant, even with a forged URL
    const forged = h.get<SignedUrlService>(SignedUrlService).mediaUrl(mB.mediaId!, 'viewer', 'adm', { grant: grant.id }).replace('http://localhost:4000', '');
    await h.http().get(forged).expect(403);
    const viewed = await h.db.many<any>(`SELECT reason, event_id FROM audit_events WHERE action = 'admin.media_viewed'`);
    expect(viewed.length).toBeGreaterThanOrEqual(1); expect(viewed[0].reason).toMatch(/ticket TKT-1234/);
    expect(await h.db.one(`SELECT 1 FROM audit_events WHERE action = 'admin.media_access_approved'`)).toBeTruthy();
    // revocation and expiry end access immediately
    await boss2.post(`/v1/admin/media-access/${grant.id}/revoke`).expect(200);
    await h.http().get(view.items[0].urls.viewer.replace('http://localhost:4000', '')).expect(403);
    await support.get(`/v1/admin/media-access/${grant.id}/media`).expect(403);
    const g2 = (await support.post('/v1/admin/media-access', { event_id: ev.id, reason: 'Second reason for review' })).body;
    await boss2.post(`/v1/admin/media-access/${g2.id}/approve`, { totp_code: await boss2.totp() }).expect(200);
    await h.db.query(`UPDATE media_access_grants SET expires_at = now() - interval '1 minute' WHERE id = $1`, [g2.id]);
    await support.get(`/v1/admin/media-access/${g2.id}/media`).expect(403);
  });
});

describe('Audit log (acceptance #21): immutable, complete, tamper-evident', () => {
  it('privileged actions appear with actor, resource, reason, before/after, IP/device context', async () => {
    const host = await Client_.host(h); const ev = await createEvent(h, host);
    const admin = await Staff.create(h, 'super_admin');
    await admin.post(`/v1/admin/events/${ev.id}/suspend`, { reason: 'safety review ticket 55', totp_code: await admin.totp() }).expect(200);
    const oldPrice = (await h.db.one<any>(`SELECT price_etb FROM plans WHERE code = 'single_event'`)).price_etb;
    await admin.patch(`/v1/admin/plans/single_event`, { price_etb: oldPrice + 100, totp_code: await admin.totp() }).expect(200);
    await admin.put('/v1/admin/settings/rights.sla_days', { value: 20, reason: 'counsel advice', totp_code: await admin.totp() }).expect(200);
    await admin.patch(`/v1/admin/events/${ev.id}/ops`, { reason: 'host asked to disable uploads', changes: { uploads_enabled: false } }).expect(409 as any).catch(() => undefined);
    const log = (await admin.get('/v1/admin/audit?limit=200').expect(200)).body as any[];
    const by = (a: string) => log.find((l) => l.action === a);
    const susp = by('event.state.live_to_suspended');
    expect(susp).toMatchObject({ actor_type: 'staff', actor_role: 'super_admin', resource_type: 'event', resource_id: ev.id, reason: 'safety review ticket 55' });
    expect(susp.before_summary).toEqual({ state: 'live' }); expect(susp.after_summary.state).toBe('suspended');
    expect(susp.ip).toBeTruthy(); expect(susp.device).toContain('jest-agent'); expect(susp.request_id).toBeTruthy();
    expect(by('admin.plan_updated')).toMatchObject({ resource_type: 'plan', after_summary: { price_etb: oldPrice + 100 }, before_summary: { price_etb: oldPrice } });
    expect(by('admin.setting_changed')).toMatchObject({ resource_id: 'rights.sla_days', reason: 'counsel advice' });
    expect(by('auth.signup')).toBeTruthy(); expect(by('event.created')).toBeTruthy();
    const filtered = (await admin.get(`/v1/admin/audit?event_id=${ev.id}`).expect(200)).body as any[];
    expect(filtered.every((l) => l.event_id === ev.id)).toBe(true);
    await h.db.query(`UPDATE plans SET price_etb = $1 WHERE code = 'single_event'`, [oldPrice]);
    await h.db.query(`UPDATE system_settings SET value = '30'::jsonb WHERE key = 'rights.sla_days'`);
    h.get<any>((await import('../../src/infra/settings.service')).SettingsService).invalidate();
    // audit summaries never carry secrets or personal data
    const all = JSON.stringify(log);
    expect(all).not.toMatch(/\+251\d{9}/); expect(all).not.toMatch(/u_[A-Za-z0-9_-]{20,}/); expect(all).not.toMatch(/phone_enc|token_hash/);
  });

  it('rows cannot be updated or deleted; a hash chain detects out-of-band tampering', async () => {
    const admin = await Staff.create(h, 'super_admin');
    await expect(h.db.query(`UPDATE audit_events SET action = 'x'`)).rejects.toThrow(/append-only/);
    await expect(h.db.query(`DELETE FROM audit_events`)).rejects.toThrow(/append-only/);
    expect((await admin.get('/v1/admin/audit/verify').expect(200)).body).toMatchObject({ brokenAtSeq: null });
    const row = await h.db.one<any>(`SELECT seq, action FROM audit_events ORDER BY seq DESC OFFSET 3 LIMIT 1`);
    try {
      await h.db.query('ALTER TABLE audit_events DISABLE TRIGGER audit_events_no_update');
      await h.db.query(`UPDATE audit_events SET reason = 'tampered' WHERE seq = $1`, [row.seq]);
      await h.db.query('ALTER TABLE audit_events ENABLE TRIGGER audit_events_no_update');
      const v = await h.get<AuditService>(AuditService).verifyChain();
      expect(Number(v.brokenAtSeq)).toBe(Number(row.seq));
    } finally {
      await h.db.query('ALTER TABLE audit_events DISABLE TRIGGER audit_events_no_update');
      await h.db.query(`UPDATE audit_events SET reason = NULL WHERE seq = $1`, [row.seq]);
      await h.db.query('ALTER TABLE audit_events ENABLE TRIGGER audit_events_no_update');
    }
  });
});

describe('Platform operations', () => {
  it('dashboard, KPIs, storage manager, payments views and orphan scan return the specified sections', async () => {
    const host = await Client_.host(h); const ev = await createEvent(h, host);
    const g = (await joinAsGuest(h, ev.uploadToken, { code: ev.joinCode })).body;
    await guestUpload(h, g, await photo(2));
    await h.http().get(`/v1/events/${ev.uploadToken}/context`);
    const admin = await Staff.create(h, 'super_admin');
    const d = (await admin.get('/v1/admin/dashboard').expect(200)).body;
    expect(Object.keys(d).sort()).toEqual(['active_events', 'events_by_state', 'failed_uploads_24h', 'incidents', 'kpis', 'media_count', 'moderation', 'payments_30d', 'queues', 'sms_usage_7d', 'storage_bytes', 'uploads_per_hour_24h']);
    expect(d.active_events).toBeGreaterThanOrEqual(1); expect(d.events_by_state.live).toBeGreaterThanOrEqual(1); expect(d.media_count).toBeGreaterThanOrEqual(0);
    expect(Object.keys(d.queues)).toEqual(expect.arrayContaining(['media-process', 'export', 'notify', 'deletion', 'maintenance']));
    const k = (await admin.get('/v1/admin/kpis').expect(200)).body;
    expect(Object.keys(k)).toEqual(expect.arrayContaining(['event_activation_rate', 'guest_join_rate', 'upload_completion_rate', 'upload_failure_rate', 'median_upload_to_publish_seconds', 'peak_concurrency', 'gallery_views', 'downloads', 'paid_conversion', 'support_tickets_per_100_events', 'deletion_compliance']));
    expect(k.upload_completion_rate).toBe(1);
    const st = (await admin.get('/v1/admin/storage').expect(200)).body;
    expect(Object.keys(st)).toEqual(expect.arrayContaining(['totals', 'by_state', 'failed_processing_7d', 'scans', 'backups', 'top_events', 'queues']));
    const scan = (await admin.post('/v1/admin/storage/orphan-scan', {}).expect(200)).body;
    expect(scan).toMatchObject({ orphans: 0, removed: 0 }); expect(scan.checked).toBeGreaterThan(0);
    for (const u of ['payments/orders', 'payments/callbacks', 'payments/reconciliation', 'payments/refunds', 'payments/invoices', 'compliance/consents', 'compliance/deletion-jobs', 'compliance/vendors', 'compliance/incidents', 'moderation/reports', 'moderation/signals', 'organizations', 'users', 'support/tickets', 'settings', 'plans', 'media-access'])
      expect((await admin.get(`/v1/admin/${u}`)).status).toBe(200);
    const funnel = (await host.get(`/v1/events/${ev.id}/insights`).expect(200)).body;
    expect(funnel.funnel).toMatchObject({ landing_view: 1, join: 1, upload_intent: 1, upload_complete: 1 });
    expect(funnel.uploads).toBe(1); expect(funnel.unique_contributors).toBe(1); expect(funnel.storage.quota_bytes).toBe(524288000);
  });

  it('incidents: explicit discovery time starts the 72h breach clock; overdue notices are flagged; vendors outside Ethiopia need assessment', async () => {
    const admin = await Staff.create(h, 'super_admin');
    const discovered = new Date(Date.now() - 80 * 3600_000).toISOString();
    const inc = (await admin.post('/v1/admin/compliance/incidents', { kind: 'personal_data_breach', severity: 'high', title: 'Misconfigured export link', discovered_at: discovered, data_categories: ['photos'], approx_subjects: 120 }).expect(200)).body;
    expect(new Date(inc.regulator_notify_due_at).getTime() - new Date(discovered).getTime()).toBe(72 * 3600_000);
    expect(inc.regulator_overdue).toBe(true);
    const upd = (await admin.patch(`/v1/admin/compliance/incidents/${inc.id}`, { regulator_notified_at: new Date().toISOString(), state: 'notified', entry: 'Authority notified via official channel' }).expect(200)).body;
    expect(upd.regulator_overdue).toBe(false);
    const detail = (await admin.get(`/v1/admin/compliance/incidents/${inc.id}`).expect(200)).body;
    expect(detail.log.length).toBe(2);
    const fresh = (await admin.post('/v1/admin/compliance/incidents', { kind: 'security', severity: 'low', title: 'Probe', discovered_at: new Date().toISOString() }).expect(200)).body;
    expect(fresh.regulator_notify_due_at).toBeNull();
    await admin.post('/v1/admin/compliance/incidents', { kind: 'security', severity: 'low', title: 'No time' }).expect(400);           // discovery time is mandatory

    const vend = { name: 'Foreign Image AI', purpose: 'photo tagging', data_location: 'Ireland', outside_ethiopia: true, status: 'active', data_categories: ['photos'] };
    const bad = await admin.put('/v1/admin/compliance/vendors', vend);
    expect(bad.status).toBe(422); expect(bad.body.error.code).toBe('transfer_assessment_required');
    expect((await admin.get('/v1/admin/compliance/vendors')).body.find((v: any) => v.name === 'Foreign Image AI').status).toBe('planned');
    await admin.put('/v1/admin/compliance/vendors', { ...vend, dpa_signed: true, transfer_assessment_ref: 'TIA-2026-001' }).expect(200);
    expect((await admin.get('/v1/admin/compliance/vendors')).body.some((v: any) => v.name.startsWith('Ethiopia-hosted infrastructure'))).toBe(true);
  });

  it('support tickets from hosts reach staff with privacy-safe account info; maintenance mode blocks writes but not staff or reads', async () => {
    const host = await Client_.host(h); const ev = await createEvent(h, host);
    const t = (await host.post('/v1/support/tickets', { category: 'refund', subject: 'ክፍያ ተቀንሷል', body: 'Charged twice for my event', event_id: ev.id }).expect(200)).body;
    expect(t.ref).toMatch(/^TKT-/);
    const other = await Client_.host(h);
    await other.post('/v1/support/tickets', { subject: 'abc', body: 'hello world', event_id: ev.id }).expect(404);
    const admin = await Staff.create(h, 'super_admin');
    const tickets = (await admin.get('/v1/admin/support/tickets').expect(200)).body;
    expect(tickets[0]).toMatchObject({ ref: t.ref, category: 'refund', subject: 'ክፍያ ተቀንሷል' }); expect(tickets[0].phone_last4).toBe(host.phone.slice(-4));
    await admin.patch(`/v1/admin/support/tickets/${tickets[0].id}`, { status: 'resolved', assign_to_me: true }).expect(200);

    await admin.put('/v1/admin/settings/maintenance.mode', { value: true, reason: 'planned database upgrade', totp_code: await admin.totp() }).expect(200);
    h.get<any>((await import('../../src/infra/settings.service')).SettingsService).invalidate();
    const blocked = await host.post('/v1/events', { name: 'x', type: 'party', city: 'Adama', starts_at: new Date(Date.now() + 1e7).toISOString(), ends_at: new Date(Date.now() + 2e7).toISOString() });
    expect(blocked.status).toBe(503); expect(blocked.body.error.code).toBe('maintenance_mode');
    await host.get('/v1/events').expect(200);
    await admin.get('/v1/admin/dashboard').expect(200);
    await admin.put('/v1/admin/settings/maintenance.mode', { value: false, reason: 'upgrade complete', totp_code: await admin.totp() }).expect(200);
    h.get<any>((await import('../../src/infra/settings.service')).SettingsService).invalidate();
    await host.post('/v1/events', { name: 'x', type: 'party', city: 'Adama', starts_at: new Date(Date.now() + 1e7).toISOString(), ends_at: new Date(Date.now() + 2e7).toISOString() }).expect(201);
  });

  it('platform moderation: staff can hide reported content without viewing it; escalations show in the platform queue', async () => {
    const host = await Client_.host(h); const ev = await createEvent(h, host);
    await host.patch(`/v1/events/${ev.id}`, { gallery_access_mode: 'view_only', report_hide_threshold: 3 }).expect(200);
    const g = (await joinAsGuest(h, ev.uploadToken, { code: ev.joinCode })).body;
    const m = await guestUpload(h, g, await photo(21));
    await host.post(`/v1/events/${ev.id}/moderation/bulk`, { action: 'approve', media_ids: [m.mediaId] }).expect(200);
    for (let i = 0; i < 3; i++) {
      const v = (await joinAsGuest(h, ev.galleryToken, { device_id: 'v' + i })).body;
      await h.http().post(`/v1/media/${m.mediaId}/report`).set('Authorization', `Bearer ${v.token}`).send({ reason: 'inappropriate' }).expect(200);
    }
    const admin = await Staff.create(h, 'support_agent');
    const reports = (await admin.get('/v1/admin/moderation/reports?status=escalated').expect(200)).body;
    expect(reports.filter((r: any) => r.media_id === m.mediaId)).toHaveLength(3);                    // 3 independent serious reports auto-escalate
    expect((await h.db.one<any>('SELECT moderation_state FROM media WHERE id = $1', [m.mediaId])).moderation_state).toBe('flagged');
    const act = await admin.post(`/v1/admin/moderation/media/${m.mediaId}/action`, { action: 'hide', reason: 'violates content policy' }).expect(200);
    expect(act.body.moderation_state).toBe('hidden');
    expect(await h.db.one(`SELECT 1 FROM moderation_logs WHERE media_id = $1 AND actor_type = 'staff' AND action = 'hide'`, [m.mediaId])).toBeTruthy();
    expect(await h.db.one(`SELECT 1 FROM audit_events WHERE action = 'moderation.hide' AND actor_type = 'staff'`)).toBeTruthy();
  });
});
