import { createHmac, timingSafeEqual } from 'crypto';
import { AppConfig } from '../common/config';
import { Db } from '../infra/db.service';
import { RedisService } from '../infra/redis.service';

/**
 * Payment provider abstraction (spec 12.1). The platform is a software merchant: customers pay through a licensed
 * Ethiopian gateway; we only ever see provider references, amounts and status - never card numbers or wallet PINs.
 */
export type TxStatus = 'success' | 'pending' | 'failed' | 'cancelled';

export interface CheckoutRequest { orderRef: string; amountEtb: number; title: string; returnUrl: string; callbackUrl: string }
export interface VerifiedTransaction { status: TxStatus; amountEtb: number; currency: string; providerReference: string; orderRef: string }
export interface ParsedCallback { orderRef: string; providerReference?: string; claimedStatus?: string }
export interface RefundResult { state: 'processing' | 'succeeded' | 'failed'; providerRefundRef?: string }

export interface PaymentProvider {
  readonly name: 'sandbox' | 'chapa' | 'telebirr';
  createCheckout(req: CheckoutRequest): Promise<{ checkoutUrl: string; providerReference?: string }>;
  /** Authenticity of the callback itself (never sufficient on its own to grant entitlement). */
  verifyCallbackSignature(headers: Record<string, string | string[] | undefined>, rawBody: Buffer): boolean;
  parseCallback(rawBody: Buffer): ParsedCallback;
  /** Independent server-to-server status check - the only source of truth for activation. Throws on provider outage. */
  verifyTransaction(orderRef: string, providerReference?: string | null): Promise<VerifiedTransaction>;
  requestRefund(orderRef: string, amountEtb: number, reason: string): Promise<RefundResult>;
}

const eqHex = (a: string, b: string) => { const x = Buffer.from(a); const y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };
const hdr = (h: Record<string, string | string[] | undefined>, k: string) => { const v = h[k]; return Array.isArray(v) ? v[0] : v; };

// ---------------------------------------------------------------------------- Sandbox (dev/test only)
export class SandboxProvider implements PaymentProvider {
  readonly name = 'sandbox' as const;
  constructor(private readonly cfg: AppConfig, private readonly db: Db, private readonly redis: RedisService) {
    if (cfg.isProd) throw new Error('Sandbox payment provider cannot run in production');
  }
  sign(raw: Buffer | string): string { return createHmac('sha256', this.cfg.SANDBOX_PAYMENT_SECRET).update(raw).digest('hex'); }

  async createCheckout(req: CheckoutRequest) {
    await this.db.query('INSERT INTO sandbox_transactions (tx_ref, amount_etb) VALUES ($1,$2) ON CONFLICT DO NOTHING', [req.orderRef, req.amountEtb]);
    if (await this.redis.client.get('sandbox:outage')) throw new Error('sandbox provider outage (simulated)');
    return { checkoutUrl: `${this.cfg.PUBLIC_WEB_URL}/pay/sandbox?ref=${req.orderRef}`, providerReference: `sbx_${req.orderRef}` };
  }
  verifyCallbackSignature(headers: Record<string, string | string[] | undefined>, raw: Buffer): boolean {
    const sig = hdr(headers, 'x-sandbox-signature');
    return !!sig && eqHex(this.sign(raw), sig);
  }
  parseCallback(raw: Buffer): ParsedCallback {
    const j = JSON.parse(raw.toString('utf8'));
    return { orderRef: String(j.tx_ref ?? ''), providerReference: j.reference ? String(j.reference) : undefined, claimedStatus: String(j.status ?? '') };
  }
  async verifyTransaction(orderRef: string): Promise<VerifiedTransaction> {
    if (await this.redis.client.get('sandbox:outage')) throw new Error('sandbox provider outage (simulated)');
    const t = await this.db.one<any>('SELECT * FROM sandbox_transactions WHERE tx_ref = $1', [orderRef]);
    if (!t) return { status: 'failed', amountEtb: 0, currency: 'ETB', providerReference: '', orderRef };
    return { status: t.status, amountEtb: Number(t.amount_etb), currency: 'ETB', providerReference: `sbx_${orderRef}`, orderRef };
  }
  async requestRefund(): Promise<RefundResult> { return { state: 'processing', providerRefundRef: undefined }; }
}

// ---------------------------------------------------------------------------- Chapa (licensed Ethiopian gateway)
export class ChapaProvider implements PaymentProvider {
  readonly name = 'chapa' as const;
  constructor(private readonly cfg: AppConfig) {}
  private get headers() { return { Authorization: `Bearer ${this.cfg.CHAPA_SECRET_KEY}`, 'Content-Type': 'application/json' }; }

  async createCheckout(req: CheckoutRequest) {
    if (!this.cfg.CHAPA_SECRET_KEY) throw new Error('Chapa is not configured');
    const res = await fetch(`${this.cfg.CHAPA_BASE_URL}/transaction/initialize`, {
      method: 'POST', headers: this.headers, signal: AbortSignal.timeout(10_000),
      body: JSON.stringify({ amount: req.amountEtb.toFixed(2), currency: 'ETB', tx_ref: req.orderRef, callback_url: req.callbackUrl, return_url: req.returnUrl, customization: { title: req.title.slice(0, 16), description: 'Event photo package' } }),
    });
    const j: any = await res.json().catch(() => ({}));
    if (!res.ok || j?.status !== 'success' || !j?.data?.checkout_url) throw new Error(`Chapa initialize failed (${res.status})`);
    return { checkoutUrl: String(j.data.checkout_url) };
  }
  verifyCallbackSignature(headers: Record<string, string | string[] | undefined>, raw: Buffer): boolean {
    if (!this.cfg.CHAPA_WEBHOOK_SECRET) return false;
    const expected = createHmac('sha256', this.cfg.CHAPA_WEBHOOK_SECRET).update(raw).digest('hex');
    const sig = hdr(headers, 'x-chapa-signature') ?? hdr(headers, 'chapa-signature');
    return !!sig && eqHex(expected, sig);
  }
  parseCallback(raw: Buffer): ParsedCallback {
    const j = JSON.parse(raw.toString('utf8'));
    return { orderRef: String(j.tx_ref ?? j.trx_ref ?? ''), providerReference: j.reference ? String(j.reference) : undefined, claimedStatus: String(j.status ?? '') };
  }
  async verifyTransaction(orderRef: string): Promise<VerifiedTransaction> {
    const res = await fetch(`${this.cfg.CHAPA_BASE_URL}/transaction/verify/${encodeURIComponent(orderRef)}`, { headers: this.headers, signal: AbortSignal.timeout(10_000) });
    if (res.status >= 500) throw new Error(`Chapa verify unavailable (${res.status})`);
    const j: any = await res.json().catch(() => ({}));
    const st = String(j?.data?.status ?? '').toLowerCase();
    const status: TxStatus = st === 'success' ? 'success' : st === 'pending' ? 'pending' : st === 'cancelled' ? 'cancelled' : 'failed';
    return { status: res.ok ? status : 'failed', amountEtb: Number(j?.data?.amount ?? 0), currency: String(j?.data?.currency ?? ''), providerReference: String(j?.data?.reference ?? j?.data?.tx_ref ?? ''), orderRef };
  }
  /** No fully automated refund is assumed: the request goes through the provider's refund workflow and stays 'processing' until staff record the provider's confirmation. */
  async requestRefund(): Promise<RefundResult> { return { state: 'processing' }; }
}

// ---------------------------------------------------------------------------- Direct telebirr (design-ready; enabled after onboarding - D23)
export class TelebirrProvider implements PaymentProvider {
  readonly name = 'telebirr' as const;
  constructor(private readonly cfg: AppConfig) {}
  private notReady(): never { throw new Error('Direct telebirr integration is not enabled yet (provider onboarding pending)'); }
  createCheckout(): Promise<{ checkoutUrl: string }> { return this.notReady(); }
  verifyCallbackSignature(): boolean { return false; }
  parseCallback(): ParsedCallback { return this.notReady(); }
  verifyTransaction(): Promise<VerifiedTransaction> { return this.notReady(); }
  requestRefund(): Promise<RefundResult> { return this.notReady(); }
}
