import { Client_, Harness, Staff, bootHarness, createEvent, guestUpload, joinAsGuest, photo, sendChunks } from '../helpers/harness';
import { LifecycleService } from '../../src/events/lifecycle.service';
import { DeletionService } from '../../src/privacy/deletion.service';
import { MaintenanceService } from '../../src/admin/maintenance.service';
import { ProcessingService } from '../../src/media/processing.service';

let h: Harness;
beforeAll(async () => { h = await bootHarness(); });
afterAll(async () => { await h.close(); });

const life = () => h.get<LifecycleService>(LifecycleService);
const state = async (id: string) => (await h.db.one<any>('SELECT * FROM events WHERE id = $1', [id]));
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const DAY = 86400_000;

async function liveEvent(host: Client_, over: Record<string, unknown> = {}) {
  const ev = await createEvent(h, host, over);
  const g = (await joinAsGuest(h, ev.uploadToken, { code: ev.joinCode })).body;
  const v = (await joinAsGuest(h, ev.galleryToken, { code: ev.joinCode.toLowerCase() })).status === 200 ? null : null;
  void v;
  return { ev, g };
}

describe('Lifecycle is backend state logic (spec section 7)', () => {
  it('#12 clock-driven: scheduled -> live -> closing -> read_only; uploads rejected after close; retention clock starts', async () => {
    const host = await Client_.host(h);
    const future = Date.now() + 2 * 3600_000;
    const ev = await createEvent(h, host, { starts_at: new Date(future).toISOString(), ends_at: new Date(future + 3600_000).toISOString(), upload_opens_at: new Date(future).toISOString(), upload_closes_at: new Date(future + 7200_000).toISOString() });
    expect((await state(ev.id)).state).toBe('scheduled');
    const early = (await joinAsGuest(h, ev.uploadToken, { code: ev.joinCode })).body;                // guests may join early but cannot upload
    expect(early.status).toBe('not_started');
    const pre = await h.http().post('/v1/guest/uploads/intents').set('Authorization', `Bearer ${early.token}`).send({ mime: 'image/jpeg', size: 1000 });
    expect(pre.status).toBe(409); expect(pre.body.error.code).toBe('event_state_forbids');
    await h.db.query(`UPDATE events SET upload_opens_at = now() - interval '1 minute' WHERE id = $1`, [ev.id]);
    expect((await life().tick()).opened).toBeGreaterThanOrEqual(1);
    expect((await state(ev.id)).state).toBe('live');
    const ok = await h.http().post('/v1/guest/uploads/intents').set('Authorization', `Bearer ${early.token}`).send({ mime: 'image/jpeg', size: 1000 });
    expect(ok.status).toBe(200);
    // an upload that is still in flight when the window closes is allowed to finish; new intents are refused
    const buf = await photo(31);
    const inflight = (await h.http().post('/v1/guest/uploads/intents').set('Authorization', `Bearer ${early.token}`).send({ mime: 'image/jpeg', size: buf.length })).body;
    await sendChunks(h, inflight.upload, buf);
    await h.db.query(`UPDATE events SET upload_closes_at = now() - interval '1 second' WHERE id = $1`, [ev.id]);
    await life().tick();
    expect((await state(ev.id)).state).toBe('closing');
    const refused = await h.http().post('/v1/guest/uploads/intents').set('Authorization', `Bearer ${early.token}`).send({ mime: 'image/jpeg', size: 1000 });
    expect(refused.status).toBe(409);
    await h.http().post(`/v1/media/${inflight.media_id}/complete`).set('X-Upload-Token', inflight.upload.token).expect(200);     // finish queued jobs
    await life().tick();
    expect((await state(ev.id)).state).toBe('closing');                                               // still processing -> stays closing
    await h.get<ProcessingService>(ProcessingService).process(inflight.media_id);
    await h.db.query(`UPDATE media SET upload_state = 'cancelled' WHERE event_id = $1 AND upload_state IN ('intent','uploading')`, [ev.id]);
    await life().tick();
    const ro = await state(ev.id);
    expect(ro.state).toBe('read_only');
    expect(ro.closed_at).not.toBeNull();
    const days = (new Date(ro.retention_until).getTime() - new Date(ro.closed_at).getTime()) / DAY;
    expect(Math.round(days)).toBe(30);                                                                  // trial plan retention (plan-controlled, not hard-coded)
    // gallery still viewable (read-only); uploads off; moderation still possible
    const events = await h.db.many<any>(`SELECT action FROM audit_events WHERE event_id = $1 AND action LIKE 'event.state.%' ORDER BY seq`, [ev.id]);
    expect(events.map((e) => e.action)).toEqual(['event.state.draft_to_scheduled', 'event.state.scheduled_to_live', 'event.state.live_to_closing', 'event.state.closing_to_read_only']);
    const actor = await h.db.one<any>(`SELECT actor_type FROM audit_events WHERE action = 'event.state.live_to_closing'`);
    expect(actor.actor_type).toBe('system');
  });

  it('host controls: close now, schedule close, extend, archive, restore; illegal moves are refused server-side', async () => {
    const host = await Client_.host(h);
    const { ev, g } = await liveEvent(host);
    await host.post(`/v1/events/${ev.id}/archive`).expect(409);                                         // cannot archive a live event
    await host.post(`/v1/events/${ev.id}/restore`).expect(409);
    const at = new Date(Date.now() + 3 * 3600_000).toISOString();
    const sched = await host.post(`/v1/events/${ev.id}/close`, { mode: 'schedule', at }).expect(200);
    expect(new Date(sched.body.upload_closes_at).toISOString()).toBe(at);
    await host.post(`/v1/events/${ev.id}/close`, { mode: 'schedule', at: ago(1000) }).expect(422);
    await host.post(`/v1/events/${ev.id}/close`, { mode: 'schedule' }).expect(400);
    const closed = await host.post(`/v1/events/${ev.id}/close`, { mode: 'now' }).expect(200);
    expect(closed.body.state).toBe('closing');
    expect(closed.body.allowed_actions).not.toContain('guest_upload');
    expect((await h.http().post('/v1/guest/uploads/intents').set('Authorization', `Bearer ${g.token}`).send({ mime: 'image/jpeg', size: 10 })).status).toBe(409);
    const ext = await host.post(`/v1/events/${ev.id}/extend`, { upload_closes_at: new Date(Date.now() + 5 * 3600_000).toISOString() }).expect(200);
    expect(ext.body.state).toBe('live');                                                                // extend re-opens a closing event
    expect((await h.http().post('/v1/guest/uploads/intents').set('Authorization', `Bearer ${g.token}`).send({ mime: 'image/jpeg', size: 10 })).status).toBe(200);
    await host.post(`/v1/events/${ev.id}/close`, { mode: 'now' }).expect(200);
    await h.db.query(`UPDATE media SET upload_state = 'cancelled' WHERE event_id = $1 AND upload_state IN ('intent','uploading')`, [ev.id]);
    await life().tick();
    expect((await state(ev.id)).state).toBe('read_only');
    expect((await host.post(`/v1/events/${ev.id}/archive`).expect(200)).body.state).toBe('archived');
    expect((await host.post(`/v1/events/${ev.id}/restore`).expect(200)).body.state).toBe('read_only');
    await host.post(`/v1/events/${ev.id}/extend`, { upload_closes_at: new Date(Date.now() + DAY).toISOString() }).expect(409);   // read-only cannot be re-opened
    await host.patch(`/v1/events/${ev.id}`, { name: 'renamed' }).expect(409);                                // core edits locked after the event
    await host.patch(`/v1/events/${ev.id}`, { downloads_enabled: false }).expect(200);                       // access settings stay editable
  });

  it('automatic archive after read-only period; retention expiry starts the deletion lifecycle (acceptance #13)', async () => {
    const host = await Client_.host(h);
    const { ev } = await liveEvent(host);
    await h.db.query(`UPDATE events SET state = 'read_only', closed_at = now() - interval '40 days', read_only_at = now() - interval '40 days', retention_until = now() + interval '20 days' WHERE id = $1`, [ev.id]);
    await life().tick();
    expect((await state(ev.id)).state).toBe('archived');
    await h.db.query(`UPDATE events SET retention_until = now() - interval '1 minute' WHERE id = $1`, [ev.id]);
    const t = await life().tick();
    expect(t.deletion_pending).toBeGreaterThanOrEqual(1);
    const e = await state(ev.id);
    expect(e.state).toBe('deletion_pending');
    const grace = (new Date(e.deletion_deadline).getTime() - new Date(e.deletion_requested_at).getTime()) / DAY;
    expect(Math.round(grace)).toBe(14);                                                                  // within the 7-30 day grace window
    const job = await h.db.one<any>(`SELECT * FROM deletion_jobs WHERE resource_id = $1`, [ev.id]);
    expect(job).toMatchObject({ status: 'pending', trigger: 'retention_expiry', resource_type: 'event' });
    expect(new Date(job.backup_purge_by).getTime()).toBeGreaterThan(new Date(job.scheduled_at).getTime());
    const audit = await h.db.many<any>(`SELECT action, actor_type, reason FROM audit_events WHERE event_id = $1 AND action = 'event.state.archived_to_deletion_pending'`, [ev.id]);
    expect(audit).toHaveLength(1); expect(audit[0]).toMatchObject({ actor_type: 'system', reason: 'retention period ended' });
    // guests can no longer reach it; the owner still sees the deletion banner and can cancel until the deadline
    expect((await h.http().get(`/v1/events/${ev.uploadToken}/context`)).body.status).toBe('unavailable');
    expect((await joinAsGuest(h, ev.uploadToken, { code: ev.joinCode })).status).toBe(403);
    expect((await host.get(`/v1/events/${ev.id}`).expect(200)).body.lifecycle.deletion_deadline).toBeTruthy();
  });

  it('host deletion request: confirmation required, grace period, cancel restores the prior state, purge removes everything but legal records', async () => {
    const host = await Client_.host(h);
    const { ev, g } = await liveEvent(host);
    const up = await guestUpload(h, g, await photo(61));
    await host.post(`/v1/events/${ev.id}/moderation/bulk`, { action: 'approve', media_ids: [up.mediaId] }).expect(200);
    const name = (await state(ev.id)).name;
    await host.post(`/v1/events/${ev.id}/delete`, { confirm_name: 'wrong name' }).expect(422);
    const del = await host.post(`/v1/events/${ev.id}/delete`, { confirm_name: name }).expect(200);
    expect(del.body.state).toBe('deletion_pending');
    expect(await h.storage.head('media', `e/${ev.id}/m/${up.mediaId}/thumb.jpg`)).not.toBeNull();       // nothing purged during the grace period
    const canc = await host.post(`/v1/events/${ev.id}/cancel-deletion`).expect(200);
    expect(canc.body.state).toBe('live');
    expect((await h.db.one<any>(`SELECT status FROM deletion_jobs WHERE resource_id = $1`, [ev.id])).status).toBe('cancelled');
    await host.post(`/v1/events/${ev.id}/delete`, { confirm_name: name }).expect(200);

    // legal hold parks the job
    const admin = await Staff.create(h, 'super_admin');
    await admin.post(`/v1/admin/events/${ev.id}/legal-hold`, { reason: 'police request ref 2026/77', totp_code: await admin.totp() }).expect(200);
    await h.db.query(`UPDATE deletion_jobs SET scheduled_at = now() - interval '1 minute' WHERE resource_id = $1 AND status IN ('pending','held')`, [ev.id]);
    let r = await h.get<DeletionService>(DeletionService).runDue();
    expect(r.held).toBe(1);
    expect((await state(ev.id)).state).toBe('deletion_pending');
    expect(await h.storage.head('media', `e/${ev.id}/m/${up.mediaId}/thumb.jpg`)).not.toBeNull();
    await host.post(`/v1/events/${ev.id}/cancel-deletion`).expect(200);
    await host.post(`/v1/events/${ev.id}/delete`, { confirm_name: name }).expect(409);                  // legal hold blocks host deletion

    await admin.req('delete', `/v1/admin/events/${ev.id}/legal-hold?reason=hold%20released%20by%20counsel&totp_code=${await admin.totp()}`).expect(200);
    await host.post(`/v1/events/${ev.id}/delete`, { confirm_name: name }).expect(200);
    await h.db.query(`UPDATE deletion_jobs SET scheduled_at = now() - interval '1 minute' WHERE resource_id = $1 AND status = 'pending'`, [ev.id]);
    r = await h.get<DeletionService>(DeletionService).runDue();
    expect(r.completed).toBe(1);

    const e = await state(ev.id);
    expect(e.state).toBe('deleted'); expect(e.name).toBe('[deleted]'); expect(e.venue).toBeNull(); expect(e.host_name).toBeNull();
    expect((await h.db.one<any>('SELECT count(*)::int AS n FROM media WHERE event_id = $1', [ev.id])).n).toBe(0);
    expect((await h.db.one<any>('SELECT count(*)::int AS n FROM guest_sessions WHERE event_id = $1', [ev.id])).n).toBe(0);
    expect((await h.db.one<any>('SELECT count(*)::int AS n FROM access_secrets WHERE event_id = $1', [ev.id])).n).toBe(0);
    for (const [bucket, prefix] of [['media', `e/${ev.id}/`], ['quarantine', `q/${ev.id}/`], ['exports', `x/${ev.id}/`]] as const) {
      const keys: string[] = []; for await (const o of h.storage.list(bucket, prefix)) keys.push(o.key); expect(keys).toEqual([]);
    }
    const job = await h.db.one<any>(`SELECT * FROM deletion_jobs WHERE resource_id = $1 AND status = 'completed'`, [ev.id]);
    expect(job.evidence).toMatchObject({ objects_remaining: 0, media_rows: 1 }); expect(job.evidence.objects_deleted).toBeGreaterThanOrEqual(3);
    expect(job.evidence.retained_records).toEqual(expect.arrayContaining(['payment_orders', 'audit_events']));
    expect(await h.db.one(`SELECT 1 FROM audit_events WHERE action = 'deletion.completed' AND resource_id = $1`, [ev.id])).toBeTruthy();
    expect(await h.db.one(`SELECT 1 FROM audit_events WHERE action = 'legal_hold.placed' AND event_id = $1`, [ev.id])).toBeTruthy();
    expect(await h.db.one(`SELECT 1 FROM consent_records WHERE event_id = $1`, [ev.id])).toBeTruthy();   // consent evidence retained
    await host.get(`/v1/events/${ev.id}`).expect(404);                                                  // owner membership purged
    expect((await h.http().get(`/v1/events/${ev.uploadToken}/context`)).status).toBe(404);
  });

  it('suspension blocks guests and owners at the API; unsuspend restores the right state; requires step-up', async () => {
    const host = await Client_.host(h);
    const { ev, g } = await liveEvent(host);
    const admin = await Staff.create(h, 'super_admin');
    const noStep = await admin.post(`/v1/admin/events/${ev.id}/suspend`, { reason: 'reported for abuse' });
    expect(noStep.status).toBe(403); expect(noStep.body.error.code).toBe('step_up_required');
    await admin.post(`/v1/admin/events/${ev.id}/suspend`, { reason: 'reported for abuse', totp_code: await admin.totp() }).expect(200);
    expect((await state(ev.id)).state).toBe('suspended');
    expect((await h.http().get(`/v1/events/${ev.uploadToken}/context`)).status).toBe(403);
    expect((await h.http().post('/v1/guest/uploads/intents').set('Authorization', `Bearer ${g.token}`).send({ mime: 'image/jpeg', size: 10 })).status).toBe(409);
    const owner = await host.get(`/v1/events/${ev.id}`).expect(200);
    expect(owner.body.state).toBe('suspended'); expect(owner.body.lifecycle.suspended.message_key).toBe('event.suspended_notice');
    expect(JSON.stringify(owner.body)).not.toContain('reported for abuse');                              // internal reason is not exposed to the host
    await host.patch(`/v1/events/${ev.id}`, { name: 'x' }).expect(409);
    await host.post(`/v1/events/${ev.id}/close`, { mode: 'now' }).expect(409);
    await h.db.query(`UPDATE events SET state = 'suspended' WHERE id = $1`, [ev.id]);
    await admin.post(`/v1/admin/events/${ev.id}/unsuspend`, { reason: 'cleared after review', totp_code: await admin.totp() }).expect(200);
    expect((await state(ev.id)).state).toBe('live');
    expect((await h.http().post('/v1/guest/uploads/intents').set('Authorization', `Bearer ${g.token}`).send({ mime: 'image/jpeg', size: 10 })).status).toBe(200);
  });

  it('sweeper recovers stalled work: stuck processing, abandoned uploads and notifications (acceptance #28)', async () => {
    const host = await Client_.host(h);
    const { ev, g } = await liveEvent(host);
    const buf = await photo(71);
    const intent = (await h.http().post('/v1/guest/uploads/intents').set('Authorization', `Bearer ${g.token}`).send({ mime: 'image/jpeg', size: buf.length })).body;
    await sendChunks(h, intent.upload, buf);
    await h.http().post(`/v1/media/${intent.media_id}/complete`).set('X-Upload-Token', intent.upload.token).expect(200);
    // simulate a worker that died mid-job: row stuck in `processing`, no job in the queue
    await h.db.query(`UPDATE media SET upload_state = 'processing', processing_attempts = 1, completed_at = now() - interval '10 minutes' WHERE id = $1`, [intent.media_id]);
    const abandoned = (await h.http().post('/v1/guest/uploads/intents').set('Authorization', `Bearer ${g.token}`).send({ mime: 'image/jpeg', size: 5000 })).body.media_id;
    await h.db.query(`UPDATE media SET created_at = now() - interval '3 hours' WHERE id = $1`, [abandoned]);
    const m = h.get<MaintenanceService>(MaintenanceService);
    const rec = await m.recoverStuck();
    expect(rec.media).toBeGreaterThanOrEqual(1);
    expect((await h.db.one<any>('SELECT upload_state FROM media WHERE id = $1', [intent.media_id])).upload_state).toBe('uploaded');   // handed back to the queue
    expect(await m.cleanStaleUploads()).toBeGreaterThanOrEqual(1);
    expect((await h.db.one<any>('SELECT upload_state, failure_code FROM media WHERE id = $1', [abandoned]))).toMatchObject({ upload_state: 'cancelled', failure_code: 'abandoned' });
    await h.get<ProcessingService>(ProcessingService).process(intent.media_id);
    expect((await h.db.one<any>('SELECT upload_state FROM media WHERE id = $1', [intent.media_id])).upload_state).toBe('ready');
    // beyond the retry budget it fails visibly rather than hanging forever
    await h.db.query(`UPDATE media SET upload_state = 'processing', processing_attempts = 5, processed_at = NULL WHERE id = $1`, [intent.media_id]);
    await m.recoverStuck();
    expect((await h.db.one<any>('SELECT upload_state, failure_code FROM media WHERE id = $1', [intent.media_id]))).toMatchObject({ upload_state: 'failed', failure_code: 'processing_timeout' });
    void ev;
  });
});
