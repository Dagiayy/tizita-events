import { Inject, Injectable, Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import { AuditService } from '../audit/audit.service';
import { AppConfig, CONFIG } from '../common/config';
import { randomFromAlphabet } from '../common/crypto';
import { E } from '../common/errors';
import { Principal } from '../common/request-context';
import { AccessService } from '../events/access.service';
import { EntitlementsService } from '../events/entitlements.service';
import { assertAllowed, stateFromClock } from '../events/lifecycle';
import { LifecycleService } from '../events/lifecycle.service';
import { Db, Q } from '../infra/db.service';
import { IdempotencyService } from '../infra/idempotency.service';
import { MetricsService } from '../infra/metrics.service';
import { RedisService } from '../infra/redis.service';
import { SettingsService } from '../infra/settings.service';
import { NotificationsService } from '../notifications/notifications.service';
import { ChapaProvider, PaymentProvider, SandboxProvider, TelebirrProvider } from './providers';

const REF_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

@Injectable()
export class PaymentsService {
  private readonly log = new Logger('Payments');
  private readonly providers = new Map<string, PaymentProvider>();

  constructor(
    private readonly db: Db,
    private readonly redis: RedisService,
    private readonly audit: AuditService,
    private readonly access: AccessService,
    private readonly ents: EntitlementsService,
    private readonly lifecycle: LifecycleService,
    private readonly notify: NotificationsService,
    private readonly idem: IdempotencyService,
    private readonly settings: SettingsService,
    private readonly metrics: MetricsService,
    @Inject(CONFIG) private readonly cfg: AppConfig,
  ) {
    if (!cfg.isProd) this.providers.set('sandbox', new SandboxProvider(cfg, db, redis));
    this.providers.set('chapa', new ChapaProvider(cfg));
    this.providers.set('telebirr', new TelebirrProvider(cfg));
  }

  provider(name: string = this.cfg.PAYMENT_PROVIDER): PaymentProvider {
    const p = this.providers.get(name);
    if (!p) throw E.notFound('unknown_provider');
    return p;
  }

  // ------------------------------------------------------------------ catalogue
  async plans(locale: 'en' | 'am' = 'en') {
    const rows = await this.db.many<any>('SELECT * FROM plans WHERE active = true ORDER BY sort_order');
    return {
      currency: 'ETB',
      plans: rows.map((p) => ({
        code: p.code, kind: p.kind, name: locale === 'am' ? p.name_am : p.name_en, description: locale === 'am' ? p.description_am : p.description_en,
        price_etb: p.price_etb, storage_bytes: Number(p.storage_bytes), max_media: p.max_media, retention_days: p.retention_days, original_storage: p.original_storage,
        max_collaborators: p.max_collaborators, photographer_seats: p.photographer_seats, concurrent_uploads: p.concurrent_uploads, branding: p.branding, watermark: p.watermark, is_trial: p.is_trial,
      })),
    };
  }

  // ------------------------------------------------------------------ order creation
  async createOrder(me: Principal, body: { event_id: string; plan_code: string }, idemKey?: string) {
    if (me.kind !== 'user') throw E.unauthorized();
    return this.idem.run(`order:${me.userId}`, idemKey, body, async () => {
      const { event } = await this.access.requireMember(me, body.event_id, 'event.pay');
      assertAllowed(event.state, 'pay');
      const plan = await this.db.one<any>('SELECT * FROM plans WHERE code = $1 AND active = true', [body.plan_code]);
      if (!plan) throw E.notFound('plan_not_found');
      if (plan.is_trial || Number(plan.price_etb) <= 0) throw E.badRequest('use_trial_activation', 'Free trial events are activated without payment.');
      const ent = await this.ents.effective(event.id);
      if (plan.kind === 'addon' && !ent.has_package) throw E.conflict('package_required', 'Choose a package before adding extras.');
      if (plan.kind === 'package' && ent.has_package) {
        const cur = await this.db.one<any>(`SELECT p.price_etb, p.code FROM entitlements en JOIN plans p ON p.id = en.plan_id WHERE en.event_id = $1 AND en.state = 'active' AND p.kind = 'package' ORDER BY en.created_at DESC LIMIT 1`, [event.id]);
        if (cur && Number(plan.price_etb) <= Number(cur.price_etb)) throw E.conflict('not_an_upgrade', 'This event already has an equal or higher package.');
      }
      if (event.state === 'draft' && new Date(event.upload_closes_at) < new Date()) throw E.unprocessable('event_window_passed', 'The upload window has already ended. Edit the event dates first.');

      // reuse a still-pending order for the same event+plan (prevents duplicate charges from double taps)
      const existing = await this.db.one<any>(
        `SELECT * FROM payment_orders WHERE event_id = $1 AND plan_id = $2 AND user_id = $3 AND state IN ('created','pending') AND created_at > now() - interval '30 minutes' ORDER BY created_at DESC LIMIT 1`, [event.id, plan.id, me.userId]);
      if (existing?.checkout_url) return this.orderDto(existing);

      const orderRef = 'ord_' + randomFromAlphabet(REF_ALPHABET, 22);
      const prov = this.provider();
      const order = await this.db.one<any>(
        `INSERT INTO payment_orders (order_ref, event_id, user_id, plan_id, amount_etb, provider, state, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,'created', now() + interval '60 minutes') RETURNING *`, [orderRef, event.id, me.userId, plan.id, plan.price_etb, prov.name]);
      try {
        const co = await prov.createCheckout({
          orderRef, amountEtb: Number(plan.price_etb), title: event.name,
          returnUrl: `${this.cfg.PUBLIC_WEB_URL}/host/events/${event.id}?payment=${orderRef}`,
          callbackUrl: `${this.cfg.PAYMENT_CALLBACK_BASE_URL}/v1/payments/callbacks/${prov.name}`,
        });
        const upd = await this.db.one<any>(`UPDATE payment_orders SET checkout_url = $2, provider_reference = $3, state = 'pending', updated_at = now() WHERE id = $1 RETURNING *`, [order.id, co.checkoutUrl, co.providerReference ?? null]);
        await this.audit.record({ action: 'payment.order_created', resourceType: 'payment_order', resourceId: order.id, eventId: event.id, after: { plan: plan.code, amount_etb: Number(plan.price_etb), provider: prov.name } });
        return this.orderDto(upd);
      } catch (e) {
        this.log.warn(`checkout creation failed: ${(e as Error).message}`);
        await this.db.query(`UPDATE payment_orders SET state = 'failed', verification_summary = '{"error":"provider_unavailable"}'::jsonb, updated_at = now() WHERE id = $1`, [order.id]);
        throw E.unavailable('payment_provider_unavailable', 'The payment service is temporarily unavailable. You have not been charged. Please try again shortly.');
      }
    });
  }

  private orderDto(o: any) {
    return { order_id: o.id, order_ref: o.order_ref, event_id: o.event_id, amount_etb: Number(o.amount_etb), currency: 'ETB', state: o.state, provider: o.provider, checkout_url: o.checkout_url, expires_at: o.expires_at, created_at: o.created_at };
  }

  /** Free trial: once per owner, never charged, strictly limited plan (spec D59). Not a payment shortcut. */
  async activateTrial(me: Principal, eventId: string) {
    if (me.kind !== 'user') throw E.unauthorized();
    const { event } = await this.access.requireMember(me, eventId, 'event.pay');
    if (event.state !== 'draft') throw E.conflict('already_activated', 'This event is already activated.');
    const plan = await this.db.one<any>(`SELECT * FROM plans WHERE is_trial = true AND active = true LIMIT 1`);
    if (!plan) throw E.notFound('trial_unavailable');
    await this.db.tx(async (c) => {
      const u = (await c.query<any>('SELECT trial_used_at FROM users WHERE id = $1 FOR UPDATE', [me.userId])).rows[0];
      if (u.trial_used_at) throw E.conflict('trial_used', 'The free trial has already been used on this account.');
      await c.query('UPDATE users SET trial_used_at = now() WHERE id = $1', [me.userId]);
      await this.ents.grant(c, eventId, plan, 'free_trial', null);
      await this.activateEvent(c, event);
      await this.audit.record({ action: 'event.trial_activated', resourceType: 'event', resourceId: eventId, eventId }, c);
    });
    return { ok: true };
  }

  // ------------------------------------------------------------------ callbacks (idempotent + independently verified)
  async handleCallback(providerName: string, headers: Record<string, string | string[] | undefined>, rawBody: Buffer): Promise<{ status: number; body: Record<string, unknown> }> {
    const prov = this.provider(providerName);
    const sigValid = (() => { try { return prov.verifyCallbackSignature(headers, rawBody); } catch { return false; } })();
    let parsed: ReturnType<PaymentProvider['parseCallback']>;
    try { parsed = prov.parseCallback(rawBody); } catch { parsed = { orderRef: '' }; }
    const dedupe = createHash('sha256').update(`${prov.name}|${parsed.orderRef}|${parsed.claimedStatus ?? ''}|${parsed.providerReference ?? ''}|${sigValid}`).digest('hex');
    let payload: unknown = {};
    try { payload = JSON.parse(rawBody.toString('utf8')); } catch { /* keep {} */ }
    const rec = await this.db.one<{ id: string }>(
      // A redelivery is only re-processed if the previous attempt never completed (outage); completed ones are no-ops.
      `INSERT INTO payment_callbacks (provider, order_ref, dedupe_key, signature_valid, payload) VALUES ($1,$2,$3,$4,$5::jsonb)
       ON CONFLICT (dedupe_key) DO UPDATE SET received_at = now(), outcome = NULL WHERE payment_callbacks.outcome IS NULL OR payment_callbacks.outcome = 'provider_outage'
       RETURNING id`,
      [prov.name, parsed.orderRef || null, dedupe, sigValid, JSON.stringify(redact(payload))]);

    if (!sigValid) {
      if (rec) await this.db.query(`UPDATE payment_callbacks SET outcome = 'rejected_signature', processed_at = now() WHERE id = $1`, [rec.id]);
      this.metrics.paymentCallbacks.inc({ provider: prov.name, outcome: 'rejected_signature' });
      await this.audit.record({ action: 'payment.callback_rejected', resourceType: 'payment_order', resourceId: parsed.orderRef || null, actor: { type: 'provider' }, after: { reason: 'invalid_signature' } });
      return { status: 401, body: { error: { code: 'invalid_signature', message: 'Invalid callback signature' } } };
    }
    if (!parsed.orderRef) return { status: 400, body: { error: { code: 'invalid_callback', message: 'Missing order reference' } } };
    if (!rec) { // exact duplicate delivery: acknowledged, no side effects
      this.metrics.paymentCallbacks.inc({ provider: prov.name, outcome: 'duplicate' });
      return { status: 200, body: { received: true, duplicate: true } };
    }
    try {
      const outcome = await this.settle(parsed.orderRef, 'callback');
      await this.db.query('UPDATE payment_callbacks SET outcome = $2, processed_at = now() WHERE id = $1', [rec.id, outcome]);
      this.metrics.paymentCallbacks.inc({ provider: prov.name, outcome });
      return { status: 200, body: { received: true, outcome } };
    } catch (e) {
      // provider outage while verifying: nothing is granted; the provider (or reconciliation) retries
      await this.db.query(`UPDATE payment_callbacks SET outcome = 'provider_outage' WHERE id = $1`, [rec.id]); // redelivery will be re-processed
      this.metrics.paymentCallbacks.inc({ provider: prov.name, outcome: 'provider_outage' });
      this.log.warn(`callback verification failed for ${parsed.orderRef}: ${(e as Error).message}`);
      return { status: 503, body: { error: { code: 'verification_unavailable', message: 'Could not verify the transaction yet. Please retry.' } } };
    }
  }

  /**
   * THE only path that can activate an entitlement. The callback (or a status poll, or reconciliation) merely
   * triggers it; the decision is based on the provider's own server-to-server verification of amount + currency + status.
   * Idempotent: the order row is locked and `paid` orders are never processed twice (plus a unique index on entitlements.order_id).
   */
  async settle(orderRef: string, source: 'callback' | 'poll' | 'reconciliation'): Promise<string> {
    const order = await this.db.one<any>('SELECT * FROM payment_orders WHERE order_ref = $1', [orderRef]);
    if (!order) return 'ignored_unknown_order';
    if (order.state === 'paid' || order.state.startsWith('refund')) return 'duplicate';
    const prov = this.provider(order.provider);
    const v = await prov.verifyTransaction(order.order_ref, order.provider_reference); // throws on outage

    return this.db.tx(async (c) => {
      const o = (await c.query<any>('SELECT * FROM payment_orders WHERE id = $1 FOR UPDATE', [order.id])).rows[0];
      if (o.state === 'paid') return 'duplicate';
      const summary = { status: v.status, amount_etb: v.amountEtb, currency: v.currency, source };
      if (v.status === 'success') {
        if (v.currency !== 'ETB' || Math.abs(v.amountEtb - Number(o.amount_etb)) > 0.001 || (v.orderRef && v.orderRef !== o.order_ref)) {
          await c.query(`UPDATE payment_orders SET state = 'mismatch', verification_summary = $2::jsonb, updated_at = now() WHERE id = $1`, [o.id, JSON.stringify(summary)]);
          await this.audit.record({ action: 'payment.mismatch', resourceType: 'payment_order', resourceId: o.id, eventId: o.event_id, actor: { type: 'provider' }, after: { expected: Number(o.amount_etb), got: v.amountEtb, currency: v.currency } }, c);
          return 'mismatch';
        }
        const plan = (await c.query<any>('SELECT * FROM plans WHERE id = $1', [o.plan_id])).rows[0];
        await c.query(`UPDATE payment_orders SET state = 'paid', verified_at = now(), provider_reference = COALESCE($2, provider_reference), verification_summary = $3::jsonb, updated_at = now() WHERE id = $1`,
          [o.id, v.providerReference || null, JSON.stringify(summary)]);
        await this.ents.grant(c, o.event_id, plan, 'payment', o.id);
        const event = (await c.query<any>('SELECT * FROM events WHERE id = $1', [o.event_id])).rows[0];
        await this.activateEvent(c, event);
        await this.createInvoice(c, o, plan);
        await this.audit.record({ action: 'payment.verified_paid', resourceType: 'payment_order', resourceId: o.id, eventId: o.event_id, actor: { type: 'provider' }, after: { plan: plan.code, source } }, c);
        this.queueConfirmation(o, event);
        return 'activated';
      }
      const next = v.status === 'cancelled' ? 'cancelled' : v.status === 'failed' ? 'failed' : null;
      if (next) {
        await c.query(`UPDATE payment_orders SET state = $2, verification_summary = $3::jsonb, updated_at = now() WHERE id = $1 AND state IN ('created','pending')`, [o.id, next, JSON.stringify(summary)]);
        return next;
      }
      return 'pending';
    });
  }

  private queueConfirmation(o: any, event: any): void {
    void this.notify.queueTransactional({ userId: o.user_id, template: 'payment_confirmed', locale: event.language, eventId: event.id, params: { event: event.name } }).catch(() => undefined);
  }

  /** Draft -> scheduled/live on first entitlement; later purchases only recompute retention for closed events. */
  async activateEvent(q: Q, event: any): Promise<void> {
    if (event.state === 'draft') {
      const target = stateFromClock(new Date(), event);
      await this.lifecycle.transition(event.id, target === 'closing' || target === 'read_only' ? 'scheduled' : target, { trigger: 'payment', reason: 'entitlement activated', q, patch: { activated_at: new Date().toISOString() } });
    } else if (event.closed_at) {
      const ent = await this.ents.effective(event.id, q);
      await q.query(`UPDATE events SET retention_until = closed_at + ($2 || ' days')::interval, updated_at = now() WHERE id = $1`, [event.id, String(ent.retention_days)]);
    }
  }

  private async createInvoice(c: Q, o: any, plan: any): Promise<void> {
    const rate = await this.settings.get<number | null>('tax.vat_rate', null);
    const seq = (await c.query<{ n: string }>(`SELECT nextval('invoice_number_seq') AS n`)).rows[0].n;
    const amount = Number(o.amount_etb);
    const tax = rate === null ? null : Math.round((amount - amount / (1 + rate)) * 100) / 100;
    const user = (await c.query<any>('SELECT organization_id FROM users WHERE id = $1', [o.user_id])).rows[0];
    await c.query(
      `INSERT INTO invoices (number, order_id, user_id, organization_id, amount_etb, tax_rate, tax_amount_etb, tax_status, line_items)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb) ON CONFLICT (order_id) DO NOTHING`,
      [`INV-${new Date().getUTCFullYear()}-${String(seq).padStart(6, '0')}`, o.id, o.user_id, user?.organization_id ?? null, amount, rate, tax, rate === null ? 'unvalidated' : 'validated',
        JSON.stringify([{ description: plan.name_en, quantity: 1, unit_price_etb: amount }])]);
  }

  // ------------------------------------------------------------------ status (owner)
  async status(me: Principal, orderId: string) {
    if (me.kind !== 'user') throw E.unauthorized();
    let o = await this.db.one<any>('SELECT * FROM payment_orders WHERE id = $1', [orderId]);
    if (!o) throw E.notFound('order_not_found');
    await this.access.requireMember(me, o.event_id, 'event.pay'); // 404 for other events' orders
    if (o.state === 'pending' && Date.now() - new Date(o.created_at).getTime() > 5_000) {
      await this.redis.hit(`pay:poll:${orderId}`, 12, 60);
      try { await this.settle(o.order_ref, 'poll'); } catch { /* outage: keep pending */ }
      o = await this.db.one<any>('SELECT * FROM payment_orders WHERE id = $1', [orderId]);
    }
    const inv = await this.db.one<any>('SELECT number, issued_at FROM invoices WHERE order_id = $1', [orderId]);
    return { ...this.orderDto(o), verified_at: o.verified_at, invoice: inv ?? null };
  }

  async listForEvent(me: Principal, eventId: string) {
    await this.access.requireMember(me, eventId, 'event.pay');
    return { orders: (await this.db.many<any>('SELECT o.*, p.code AS plan_code FROM payment_orders o JOIN plans p ON p.id = o.plan_id WHERE o.event_id = $1 ORDER BY o.created_at DESC', [eventId])).map((o) => ({ ...this.orderDto(o), plan_code: o.plan_code })) };
  }

  // ------------------------------------------------------------------ reconciliation (daily + on demand)
  async reconcile(provider = this.cfg.PAYMENT_PROVIDER, lookbackHours = 72) {
    const prov = this.provider(provider);
    const orders = await this.db.many<any>(
      `SELECT * FROM payment_orders WHERE provider = $1 AND created_at > now() - ($2 || ' hours')::interval AND state IN ('pending','created','paid','mismatch') ORDER BY created_at`, [provider, String(lookbackHours)]);
    const report: any[] = []; let matched = 0; let mismatched = 0; let outage = false;
    for (const o of orders) {
      try {
        const v = await prov.verifyTransaction(o.order_ref, o.provider_reference);
        if (o.state === 'paid') {
          const ok = v.status === 'success' && Math.abs(v.amountEtb - Number(o.amount_etb)) < 0.001;
          if (ok) matched++; else { mismatched++; report.push({ order_ref: o.order_ref, issue: 'paid_locally_but_provider_disagrees', provider_status: v.status }); }
        } else if (v.status === 'success') {
          const out = await this.settle(o.order_ref, 'reconciliation');
          report.push({ order_ref: o.order_ref, issue: 'recovered_missed_callback', outcome: out });
          if (out === 'activated') matched++; else mismatched++;
        } else if (v.status === 'failed' || v.status === 'cancelled') { await this.settle(o.order_ref, 'reconciliation'); matched++; }
      } catch { outage = true; break; }
    }
    const run = await this.db.one<any>(
      `INSERT INTO reconciliation_runs (provider, run_date, checked, matched, mismatched, outage, report) VALUES ($1, (now() AT TIME ZONE 'Africa/Addis_Ababa')::date,$2,$3,$4,$5,$6::jsonb)
       ON CONFLICT (provider, run_date) DO UPDATE SET checked = EXCLUDED.checked, matched = EXCLUDED.matched, mismatched = EXCLUDED.mismatched, outage = EXCLUDED.outage, report = EXCLUDED.report RETURNING *`,
      [provider, orders.length, matched, mismatched, outage, JSON.stringify(report)]);
    await this.audit.record({ action: 'payment.reconciliation_run', resourceType: 'reconciliation_run', resourceId: run.id, actor: { type: 'system' }, after: { checked: orders.length, matched, mismatched, outage } });
    return run;
  }

  // ------------------------------------------------------------------ refunds (never faked locally)
  async requestRefund(staffId: string, orderId: string, amount: number | undefined, reason: string) {
    const o = await this.db.one<any>('SELECT * FROM payment_orders WHERE id = $1', [orderId]);
    if (!o) throw E.notFound('order_not_found');
    if (o.state !== 'paid') throw E.conflict('order_not_refundable', 'Only paid orders can be refunded.');
    const amt = amount ?? Number(o.amount_etb);
    if (amt <= 0 || amt > Number(o.amount_etb)) throw E.unprocessable('invalid_amount');
    const prov = this.provider(o.provider);
    let result;
    try { result = await prov.requestRefund(o.order_ref, amt, reason); }
    catch (e) { throw E.unavailable('payment_provider_unavailable', 'The provider could not accept the refund request right now.'); }
    return this.db.tx(async (c) => {
      const r = (await c.query<any>(
        `INSERT INTO refunds (order_id, amount_etb, reason, state, provider_refund_ref, requested_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [o.id, amt, reason, result.state === 'succeeded' ? 'succeeded' : result.state === 'failed' ? 'failed' : 'processing', result.providerRefundRef ?? null, staffId])).rows[0];
      if (r.state === 'succeeded') await this.finishRefund(c, o, r);
      else if (r.state === 'processing') await c.query(`UPDATE payment_orders SET state = 'refund_requested', updated_at = now() WHERE id = $1`, [o.id]);
      await this.audit.record({ action: 'payment.refund_requested', resourceType: 'payment_order', resourceId: o.id, eventId: o.event_id, reason, after: { amount_etb: amt, state: r.state } }, c);
      return r;
    });
  }

  /** Staff record the provider's confirmation (evidence reference) once the provider completes the refund. */
  async confirmRefund(staffId: string, refundId: string, providerRefundRef: string) {
    return this.db.tx(async (c) => {
      const r = (await c.query<any>('SELECT * FROM refunds WHERE id = $1 FOR UPDATE', [refundId])).rows[0];
      if (!r) throw E.notFound('refund_not_found');
      if (r.state === 'succeeded') return r;
      if (r.state !== 'processing') throw E.conflict('refund_not_pending');
      const o = (await c.query<any>('SELECT * FROM payment_orders WHERE id = $1', [r.order_id])).rows[0];
      await c.query(`UPDATE refunds SET state = 'succeeded', provider_refund_ref = $2, decided_by = $3, updated_at = now() WHERE id = $1`, [refundId, providerRefundRef, staffId]);
      await this.finishRefund(c, o, { ...r, provider_refund_ref: providerRefundRef });
      await this.audit.record({ action: 'payment.refund_confirmed', resourceType: 'refund', resourceId: refundId, eventId: o.event_id, after: { provider_refund_ref: providerRefundRef } }, c);
      return { ...r, state: 'succeeded' };
    });
  }

  async failRefund(staffId: string, refundId: string, note: string) {
    const r = await this.db.one<any>(`UPDATE refunds SET state = 'failed', decided_by = $2, reason = reason || ' | ' || $3, updated_at = now() WHERE id = $1 AND state = 'processing' RETURNING *`, [refundId, staffId, note]);
    if (!r) throw E.conflict('refund_not_pending');
    await this.db.query(`UPDATE payment_orders SET state = 'paid', updated_at = now() WHERE id = $1 AND state = 'refund_requested'`, [r.order_id]);
    await this.audit.record({ action: 'payment.refund_failed', resourceType: 'refund', resourceId: refundId, reason: note });
    return r;
  }

  private async finishRefund(c: Q, order: any, refund: any): Promise<void> {
    const full = Math.abs(Number(refund.amount_etb) - Number(order.amount_etb)) < 0.001;
    await c.query(`UPDATE payment_orders SET state = $2, updated_at = now() WHERE id = $1`, [order.id, full ? 'refunded' : 'paid']);
    if (full) {
      await c.query(`UPDATE entitlements SET state = 'revoked', effective_to = now() WHERE order_id = $1`, [order.id]);
      await c.query(`UPDATE invoices SET status = 'credited' WHERE order_id = $1`, [order.id]);
    }
  }
}

/** Payloads are kept for troubleshooting but personal fields (names, phones, emails) are dropped. */
function redact(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(redact);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) out[k] = /(name|phone|email|mobile|msisdn|account|card|pin)/i.test(k) ? '[redacted]' : redact(val);
    return out;
  }
  return v;
}
