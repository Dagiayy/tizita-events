import { Client_, Harness, Staff, bootHarness, createEvent } from '../helpers/harness';
import { PaymentsService } from '../../src/payments/payments.service';
import { SandboxProvider } from '../../src/payments/providers';
import { MemorySmsProvider } from '../../src/notifications/notifications.service';

let h: Harness;
beforeAll(async () => { h = await bootHarness(); });
afterAll(async () => { await h.close(); });

const draft = (host: Client_, over: Record<string, unknown> = {}) => createEvent(h, host, over, 'none');
const sandbox = () => h.get<PaymentsService>(PaymentsService).provider('sandbox') as SandboxProvider;
const entCount = async (eventId: string) => (await h.db.one<any>(`SELECT count(*)::int AS n FROM entitlements WHERE event_id = $1 AND state = 'active'`, [eventId])).n;
const post = (raw: string, sig: string | null) => { const r = h.http().post('/v1/payments/callbacks/sandbox').set('Content-Type', 'application/json'); if (sig) r.set('x-sandbox-signature', sig); return r.send(raw); };
const signedCallback = (body: object) => { const raw = JSON.stringify(body); return post(raw, sandbox().sign(Buffer.from(raw))); };

describe('Plans and orders (ETB, server-priced)', () => {
  it('lists ETB-only packages with Amharic names; amounts always come from the server', async () => {
    const en = await h.http().get('/v1/plans').expect(200);
    expect(en.body.currency).toBe('ETB');
    expect(en.body.plans.map((p: any) => p.code)).toEqual(['trial', 'single_event', 'event_plus', 'professional', 'addon_storage_10gb', 'addon_retention_90d']);
    const am = await h.http().get('/v1/plans?lang=am').expect(200);
    expect(am.body.plans[1].name).toBe('ነጠላ ዝግጅት');
    expect(JSON.stringify(en.body)).not.toMatch(/USD|EUR|\$/);

    const host = await Client_.host(h); const ev = await draft(host);
    await host.post('/v1/payments/orders', { event_id: ev.id, plan_code: 'single_event', amount_etb: 1 }).expect(400);   // client cannot set price
    const o = await host.post('/v1/payments/orders', { event_id: ev.id, plan_code: 'single_event' }).expect(200);
    expect(o.body).toMatchObject({ amount_etb: 1200, currency: 'ETB', state: 'pending', provider: 'sandbox' });
    expect(o.body.checkout_url).toContain('/pay/sandbox?ref=');
    expect(await entCount(ev.id)).toBe(0);                                                  // an order alone never grants anything
    expect((await host.get(`/v1/events/${ev.id}`)).body.state).toBe('draft');
    await host.post('/v1/payments/orders', { event_id: ev.id, plan_code: 'trial' }).expect(400);   // trial is not a purchasable order
    await host.post('/v1/payments/orders', { event_id: ev.id, plan_code: 'addon_storage_10gb' }).expect(409);   // package first
    await host.post('/v1/payments/orders', { event_id: ev.id, plan_code: 'nope' }).expect(404);
  });

  it('double taps and idempotency keys never create duplicate orders', async () => {
    const host = await Client_.host(h); const ev = await draft(host);
    const k = { 'Idempotency-Key': 'order-key-0001' };
    const a = await host.req('post', '/v1/payments/orders').set(k).send({ event_id: ev.id, plan_code: 'single_event' }).expect(200);
    const b = await host.req('post', '/v1/payments/orders').set(k).send({ event_id: ev.id, plan_code: 'single_event' }).expect(200);
    expect(b.body.order_id).toBe(a.body.order_id);
    const reuse = await host.req('post', '/v1/payments/orders').set(k).send({ event_id: ev.id, plan_code: 'event_plus' });
    expect(reuse.status).toBe(422); expect(reuse.body.error.code).toBe('idempotency_key_reuse');
    const c = await host.post('/v1/payments/orders', { event_id: ev.id, plan_code: 'single_event' }).expect(200);
    expect(c.body.order_id).toBe(a.body.order_id);                                          // pending order reused
    expect((await h.db.one<any>('SELECT count(*)::int AS n FROM payment_orders WHERE event_id = $1', [ev.id])).n).toBe(1);
  });

  it('other hosts cannot read someone else\'s order or pay for their event', async () => {
    const a = await Client_.host(h); const b = await Client_.host(h); const ev = await draft(a);
    const o = await a.post('/v1/payments/orders', { event_id: ev.id, plan_code: 'single_event' }).expect(200);
    await b.get(`/v1/payments/${o.body.order_id}/status`).expect(404);
    await b.post('/v1/payments/orders', { event_id: ev.id, plan_code: 'single_event' }).expect(404);
    await h.http().get(`/v1/payments/${o.body.order_id}/status`).expect(401);
  });
});

describe('Callbacks: verified, idempotent, safe', () => {
  it('#15 success activates once; duplicate callbacks are no-ops (one entitlement, one invoice, one notification)', async () => {
    const host = await Client_.host(h); const ev = await draft(host);
    const o = (await host.post('/v1/payments/orders', { event_id: ev.id, plan_code: 'event_plus' }).expect(200)).body;
    const ref = o.order_ref;
    const first = await h.http().post('/v1/dev/sandbox/pay').send({ tx_ref: ref, outcome: 'success' }).expect(200);
    expect(first.body.outcome).toBe('activated');
    const evNow = (await host.get(`/v1/events/${ev.id}`)).body;
    expect(['scheduled', 'live']).toContain(evNow.state);
    expect(evNow.entitlement).toMatchObject({ has_package: true, original_storage: true, storage_bytes: 21474836480, retention_days: 365 });
    for (let i = 0; i < 3; i++) {
      const dup = await h.http().post('/v1/dev/sandbox/pay').send({ tx_ref: ref, outcome: 'success' }).expect(200);
      expect(dup.body.duplicate ?? dup.body.outcome).toBeTruthy();
    }
    const raw = await signedCallback({ tx_ref: ref, status: 'success', reference: `sbx_${ref}` });
    expect(raw.status).toBe(200);
    expect(await entCount(ev.id)).toBe(1);
    expect((await h.db.one<any>('SELECT count(*)::int AS n FROM invoices WHERE order_id = $1', [o.order_id])).n).toBe(1);
    const st = await host.get(`/v1/payments/${o.order_id}/status`).expect(200);
    expect(st.body).toMatchObject({ state: 'paid' }); expect(st.body.invoice.number).toMatch(/^INV-\d{4}-\d{6}$/);
    const inv = await h.db.one<any>('SELECT * FROM invoices WHERE order_id = $1', [o.order_id]); expect(inv.tax_status).toBe('unvalidated');          // VAT treatment awaits accountant (D57)
    expect(await h.db.one(`SELECT 1 FROM audit_events WHERE action = 'payment.verified_paid'`)).toBeTruthy();
    expect(MemorySmsProvider.outbox.length).toBeGreaterThan(0);
  });

  it('#16 invalid signature never activates, is logged and answered 401', async () => {
    const host = await Client_.host(h); const ev = await draft(host);
    const o = (await host.post('/v1/payments/orders', { event_id: ev.id, plan_code: 'single_event' })).body;
    await h.db.query(`UPDATE sandbox_transactions SET status = 'success' WHERE tx_ref = $1`, [o.order_ref]);      // even if the provider really has it as paid
    const body = JSON.stringify({ tx_ref: o.order_ref, status: 'success' });
    expect((await post(body, null)).status).toBe(401);
    expect((await post(body, 'a'.repeat(64))).status).toBe(401);
    expect((await post(JSON.stringify({ tx_ref: o.order_ref, status: 'success', extra: 1 }), sandbox().sign(Buffer.from(body)))).status).toBe(401);   // body tampered after signing
    expect(await entCount(ev.id)).toBe(0);
    expect((await h.db.one<any>('SELECT state FROM payment_orders WHERE id = $1', [o.order_id])).state).toBe('pending');
    const logged = await h.db.many<any>(`SELECT signature_valid, outcome FROM payment_callbacks WHERE order_ref = $1`, [o.order_ref]);
    expect(logged.length).toBeGreaterThan(0); expect(logged.every((l) => l.signature_valid === false && l.outcome === 'rejected_signature')).toBe(true);
    expect((await h.http().post('/v1/payments/callbacks/unknown').send({}).expect(404)).status).toBe(404);
  });

  it('a validly signed callback that CLAIMS success is not enough: provider verification decides', async () => {
    const host = await Client_.host(h); const ev = await draft(host);
    const o = (await host.post('/v1/payments/orders', { event_id: ev.id, plan_code: 'single_event' })).body;
    const r = await signedCallback({ tx_ref: o.order_ref, status: 'success' });             // provider status is still 'pending'
    expect(r.status).toBe(200); expect(r.body.outcome).toBe('pending');
    expect(await entCount(ev.id)).toBe(0);
    const cancelled = await h.http().post('/v1/dev/sandbox/pay').send({ tx_ref: o.order_ref, outcome: 'cancelled' }).expect(200);
    expect(cancelled.body.outcome).toBe('cancelled');
    expect((await h.db.one<any>('SELECT state FROM payment_orders WHERE id = $1', [o.order_id])).state).toBe('cancelled');
    expect(await entCount(ev.id)).toBe(0);
  });

  it('amount/currency mismatch from the provider is quarantined as `mismatch` and grants nothing', async () => {
    const host = await Client_.host(h); const ev = await draft(host);
    const o = (await host.post('/v1/payments/orders', { event_id: ev.id, plan_code: 'event_plus' })).body;
    await h.db.query(`UPDATE sandbox_transactions SET amount_etb = 10 WHERE tx_ref = $1`, [o.order_ref]);
    const r = await h.http().post('/v1/dev/sandbox/pay').send({ tx_ref: o.order_ref, outcome: 'success' }).expect(200);
    expect(r.body.outcome).toBe('mismatch');
    expect(await entCount(ev.id)).toBe(0);
    expect(await h.db.one(`SELECT 1 FROM audit_events WHERE action = 'payment.mismatch'`)).toBeTruthy();
    const other = (await host.post('/v1/payments/orders', { event_id: ev.id, plan_code: 'single_event' })).body;
    expect(other.order_ref).not.toBe(o.order_ref);
    expect((await signedCallback({ tx_ref: 'ord_doesnotexist000000000000', status: 'success' })).body.outcome).toBe('ignored_unknown_order');
  });

  it('#30 provider outage: checkout fails safely, callbacks are not trusted blindly, redelivery and reconciliation recover', async () => {
    const host = await Client_.host(h); const ev = await draft(host); const ev2 = await draft(host);
    await h.redis.client.set('sandbox:outage', '1');
    const failed = await host.post('/v1/payments/orders', { event_id: ev.id, plan_code: 'single_event' });
    expect(failed.status).toBe(503); expect(failed.body.error.code).toBe('payment_provider_unavailable');
    expect(failed.body.error.message).toMatch(/not been charged/);
    expect((await h.db.one<any>('SELECT state FROM payment_orders WHERE event_id = $1', [ev.id])).state).toBe('failed');
    expect(await entCount(ev.id)).toBe(0);
    await h.redis.client.del('sandbox:outage');
    const o = (await host.post('/v1/payments/orders', { event_id: ev2.id, plan_code: 'single_event' }).expect(200)).body;
    await h.db.query(`UPDATE sandbox_transactions SET status = 'success' WHERE tx_ref = $1`, [o.order_ref]);
    await h.redis.client.set('sandbox:outage', '1');
    const cb = await signedCallback({ tx_ref: o.order_ref, status: 'success' });             // provider unreachable while verifying
    expect(cb.status).toBe(503);
    expect(await entCount(ev2.id)).toBe(0);                                                  // nothing granted on an unverified claim
    const run = await h.get<PaymentsService>(PaymentsService).reconcile('sandbox');
    expect(run.outage).toBe(true);
    await h.redis.client.del('sandbox:outage');
    const redelivery = await signedCallback({ tx_ref: o.order_ref, status: 'success' });     // same payload is processed this time
    expect(redelivery.status).toBe(200); expect(redelivery.body.outcome).toBe('activated');
    expect(await entCount(ev2.id)).toBe(1);
  });

  it('reconciliation recovers a paid order whose callback never arrived, and flags disagreements', async () => {
    const host = await Client_.host(h); const ev = await draft(host); const ev2 = await draft(host);
    const lost = (await host.post('/v1/payments/orders', { event_id: ev.id, plan_code: 'single_event' })).body;
    await h.db.query(`UPDATE sandbox_transactions SET status = 'success' WHERE tx_ref = $1`, [lost.order_ref]);   // paid at provider, callback lost
    const paid = (await host.post('/v1/payments/orders', { event_id: ev2.id, plan_code: 'single_event' })).body;
    await h.http().post('/v1/dev/sandbox/pay').send({ tx_ref: paid.order_ref, outcome: 'success' }).expect(200);
    await h.db.query(`UPDATE sandbox_transactions SET status = 'failed' WHERE tx_ref = $1`, [paid.order_ref]);    // provider later disagrees
    const run = await h.get<PaymentsService>(PaymentsService).reconcile('sandbox');
    expect(run.outage).toBe(false);
    const mine = run.report.filter((r: any) => [lost.order_ref, paid.order_ref].includes(r.order_ref));
    expect(mine.map((r: any) => r.issue).sort()).toEqual(['paid_locally_but_provider_disagrees', 'recovered_missed_callback']);
    expect(await entCount(ev.id)).toBe(1);
    expect(run.mismatched).toBeGreaterThanOrEqual(1);
  });

  it('upgrades are explicit: a higher package replaces the lower one, downgrades are refused, add-ons stack', async () => {
    const host = await Client_.host(h); const ev = await draft(host);
    const pay = async (plan: string) => { const o = (await host.post('/v1/payments/orders', { event_id: ev.id, plan_code: plan }).expect(200)).body; return h.http().post('/v1/dev/sandbox/pay').send({ tx_ref: o.order_ref, outcome: 'success' }).expect(200); };
    await pay('single_event');
    let e = (await host.get(`/v1/events/${ev.id}`)).body;
    expect(e.entitlement.storage_bytes).toBe(5 * 1024 ** 3);
    await host.post('/v1/payments/orders', { event_id: ev.id, plan_code: 'single_event' }).expect(409);       // not an upgrade
    await pay('addon_storage_10gb');
    e = (await host.get(`/v1/events/${ev.id}`)).body;
    expect(e.entitlement.storage_bytes).toBe(15 * 1024 ** 3);
    await pay('event_plus');
    e = (await host.get(`/v1/events/${ev.id}`)).body;
    expect(e.entitlement).toMatchObject({ storage_bytes: 30 * 1024 ** 3, original_storage: true });             // 20 GB package + 10 GB add-on
    await host.post('/v1/payments/orders', { event_id: ev.id, plan_code: 'single_event' }).expect(409);
    expect(await entCount(ev.id)).toBe(2);
  });
});

describe('Refunds are never faked locally', () => {
  it('request -> processing -> only staff-recorded provider confirmation completes it; entitlement then revoked; step-up required', async () => {
    const host = await Client_.host(h); const ev = await draft(host);
    const o = (await host.post('/v1/payments/orders', { event_id: ev.id, plan_code: 'single_event' })).body;
    await h.http().post('/v1/dev/sandbox/pay').send({ tx_ref: o.order_ref, outcome: 'success' }).expect(200);
    const admin = await Staff.create(h, 'super_admin'); const support = await Staff.create(h, 'support_agent');
    await support.post(`/v1/admin/payments/orders/${o.order_id}/refund`, { reason: 'duplicate payment', totp_code: await support.totp() }).expect(403);   // support agents cannot refund
    const noTotp = await admin.post(`/v1/admin/payments/orders/${o.order_id}/refund`, { reason: 'customer request' });
    expect(noTotp.status).toBe(403); expect(noTotp.body.error.code).toBe('step_up_required');
    const r = await admin.post(`/v1/admin/payments/orders/${o.order_id}/refund`, { reason: 'customer request', totp_code: await admin.totp() }).expect(200);
    expect(r.body.state).toBe('processing');
    expect((await h.db.one<any>('SELECT state FROM payment_orders WHERE id = $1', [o.order_id])).state).toBe('refund_requested');
    expect(await entCount(ev.id)).toBe(1);                                                    // still entitled until the provider completes it
    await admin.post(`/v1/admin/payments/refunds/${r.body.id}/confirm`, { provider_refund_ref: 'RF-2026-0001', totp_code: await admin.totp() }).expect(200);
    expect((await h.db.one<any>('SELECT state FROM payment_orders WHERE id = $1', [o.order_id])).state).toBe('refunded');
    expect(await entCount(ev.id)).toBe(0);
    expect((await h.db.one<any>('SELECT status FROM invoices WHERE order_id = $1', [o.order_id])).status).toBe('credited');
    await admin.post(`/v1/admin/payments/orders/${o.order_id}/refund`, { reason: 'again', totp_code: await admin.totp() }).expect(409);
    const audit = await admin.get('/v1/admin/audit?action=payment.refund').expect(200);
    expect(audit.body.map((a: any) => a.action)).toEqual(expect.arrayContaining(['payment.refund_requested', 'payment.refund_confirmed']));
    const list = await admin.get('/v1/admin/payments/refunds').expect(200);
    expect(list.body[0].provider_refund_ref).toBe('RF-2026-0001');
  });
});

describe('Payment data minimisation', () => {
  it('callback payloads redact personal fields and no credentials are ever stored', async () => {
    const host = await Client_.host(h); const ev = await draft(host);
    const o = (await host.post('/v1/payments/orders', { event_id: ev.id, plan_code: 'single_event' })).body;
    await signedCallback({ tx_ref: o.order_ref, status: 'pending', first_name: 'Abebe', phone_number: '0911000000', card_pin: '1234' });
    const cb = await h.db.one<any>('SELECT payload FROM payment_callbacks WHERE order_ref = $1', [o.order_ref]);
    expect(cb.payload.first_name).toBe('[redacted]'); expect(cb.payload.phone_number).toBe('[redacted]'); expect(cb.payload.card_pin).toBe('[redacted]');
    const cols = (await h.db.many<any>(`SELECT column_name FROM information_schema.columns WHERE table_name IN ('payment_orders','payment_callbacks','refunds','invoices')`)).map((c) => c.column_name);
    expect(cols.filter((c) => /pin|card|cvv|password|wallet|secret/i.test(c))).toEqual([]);
  });
});
