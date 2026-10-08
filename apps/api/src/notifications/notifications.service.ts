import { Inject, Injectable, Logger } from '@nestjs/common';
import { AppConfig, CONFIG } from '../common/config';
import { CryptoService } from '../common/crypto';
import { E } from '../common/errors';
import { Db } from '../infra/db.service';
import { QUEUES, QueueService } from '../infra/queue.service';
import { SettingsService } from '../infra/settings.service';

/** SMS provider abstraction (spec 3.3 / 20): replaceable local aggregator, with primary + fallback routes. */
export interface SmsProvider {
  readonly name: string;
  send(toE164: string, text: string, senderId?: string): Promise<{ providerRef: string }>;
}

class ConsoleSmsProvider implements SmsProvider {
  readonly name = 'console';
  private readonly log = new Logger('SMS:console');
  send(to: string, text: string) { this.log.log(`to=${to.slice(0, 7)}*** body="${text}"`); return Promise.resolve({ providerRef: 'console' }); }
}

/** Test provider: records messages in memory so tests can read OTPs. Never enabled in production. */
export class MemorySmsProvider implements SmsProvider {
  readonly name = 'memory';
  static outbox: { to: string; text: string; at: number }[] = [];
  send(to: string, text: string) { MemorySmsProvider.outbox.push({ to, text, at: Date.now() }); return Promise.resolve({ providerRef: 'memory' }); }
  static last(to: string): string | undefined { return [...MemorySmsProvider.outbox].reverse().find((m) => m.to === to)?.text; }
  static lastCode(to: string): string | undefined { return /\b(\d{4,8})\b/.exec(this.last(to) ?? '')?.[1]; }
}

/** Generic JSON-over-HTTPS adapter for a local SMS/A2P aggregator. The aggregator must be Ethiopia-hosted/Ethiopian-routed. */
class HttpSmsProvider implements SmsProvider {
  constructor(readonly name: string, private readonly url: string, private readonly apiKey: string, private readonly senderId: string) {}
  async send(to: string, text: string, senderId?: string) {
    const res = await fetch(this.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({ to, from: senderId || this.senderId, message: text }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`SMS provider ${this.name} responded ${res.status}`);
    const body: any = await res.json().catch(() => ({}));
    return { providerRef: String(body.id ?? body.message_id ?? 'ok') };
  }
}

type Locale = 'en' | 'am';
const TEMPLATES: Record<string, Record<Locale, string>> = {
  otp_host_login: {
    en: 'Your verification code is {code}. It expires in {minutes} minutes. Do not share it.',
    am: 'የማረጋገጫ ኮድዎ {code} ነው። በ{minutes} ደቂቃ ውስጥ ያበቃል። ለማንም አያጋሩ።',
  },
  otp_guest_verify: {
    en: 'Your code to join the event is {code}. It expires in {minutes} minutes.',
    am: 'ዝግጅቱን ለመቀላቀል ኮድዎ {code} ነው። በ{minutes} ደቂቃ ውስጥ ያበቃል።',
  },
  payment_confirmed: {
    en: 'Payment received for "{event}". Your event is now active.',
    am: 'ለ"{event}" ክፍያ ደርሷል። ዝግጅትዎ አሁን ንቁ ነው።',
  },
  event_closing_soon: {
    en: 'Uploads for "{event}" close soon. Export your album from the console.',
    am: 'የ"{event}" ፎቶ መጫን በቅርቡ ይዘጋል። አልበምዎን ከኮንሶሉ ያውርዱ።',
  },
  deletion_scheduled: {
    en: '"{event}" will be permanently deleted on {date}. Open the console to cancel or export.',
    am: '"{event}" በ{date} ለዘለቄታው ይሰረዛል። ለማቆም ወይም ለማውረድ ኮንሶሉን ይክፈቱ።',
  },
  invite_collaborator: {
    en: 'You were invited to help with "{event}". Sign in with this phone number to accept.',
    am: 'በ"{event}" እንዲተባበሩ ተጋብዘዋል። ለመቀበል በዚህ ስልክ ቁጥር ይግቡ።',
  },
};
export const SECRET_TEMPLATES = new Set(['otp_host_login', 'otp_guest_verify']);

@Injectable()
export class NotificationsService {
  private readonly log = new Logger('Notifications');
  private readonly providers: SmsProvider[];

  constructor(@Inject(CONFIG) private readonly cfg: AppConfig, private readonly db: Db, private readonly crypto: CryptoService, private readonly queues: QueueService, private readonly settings: SettingsService) {
    this.providers = cfg.SMS_PROVIDERS.split(',').map((s) => s.trim()).filter(Boolean).map((n) => this.build(n));
    if (!this.providers.length) throw new Error('SMS_PROVIDERS must list at least one provider');
  }

  private build(name: string): SmsProvider {
    if (name === 'console') return new ConsoleSmsProvider();
    if (name === 'memory') return new MemorySmsProvider();
    const key = name.toUpperCase();
    const url = (this.cfg as any)[`SMS_HTTP_${key}_URL`] as string | undefined;
    if (!url) throw new Error(`SMS provider "${name}" is not configured (SMS_HTTP_${key}_URL)`);
    return new HttpSmsProvider(name, url, (this.cfg as any)[`SMS_HTTP_${key}_API_KEY`] ?? '', (this.cfg as any)[`SMS_HTTP_${key}_SENDER_ID`] ?? 'EventPhoto');
  }

  /** Renders a localized template. Admin overrides (`notification.templates`) win, but OTP templates must keep their placeholders. */
  async render(template: string, locale: string, params: Record<string, string | number>): Promise<string> {
    const t = TEMPLATES[template];
    if (!t) throw new Error(`unknown template ${template}`);
    const lang: Locale = locale === 'am' ? 'am' : 'en';
    let body = t[lang];
    const overrides = await this.settings.get<Record<string, Partial<Record<Locale, string>>>>('notification.templates', {});
    const o = overrides?.[template]?.[lang];
    if (o && (!SECRET_TEMPLATES.has(template) || (o.includes('{code}') && o.includes('{minutes}')))) body = o;
    return body.replace(/\{(\w+)\}/g, (_m, k) => String(params[k] ?? ''));
  }

  private async sender(): Promise<string | undefined> {
    const v = await this.settings.get<string>('sms.sender_id', '');
    return typeof v === 'string' && v ? v : undefined;
  }

  /**
   * Sends immediately (OTP path). The OTP code is rendered into the message at send time and is never
   * stored: the notifications row keeps only template + non-secret params.
   */
  async sendNow(opts: { phone: string; template: string; locale: string; params: Record<string, string | number>; userId?: string | null; sessionId?: string | null; eventId?: string | null }): Promise<void> {
    const text = await this.render(opts.template, opts.locale, opts.params);
    const sender = await this.sender();
    const safeParams = SECRET_TEMPLATES.has(opts.template) ? {} : opts.params;
    const row = await this.db.one<{ id: string }>(
      `INSERT INTO notifications (recipient_user_id, recipient_session_id, channel, template, locale, params, event_id)
       VALUES ($1, $2, 'sms', $3, $4, $5::jsonb, $6) RETURNING id`,
      [opts.userId ?? null, opts.sessionId ?? null, opts.template, opts.locale, JSON.stringify(safeParams), opts.eventId ?? null]);
    let lastErr: unknown;
    for (const p of this.providers) {
      try {
        const r = await p.send(opts.phone, text, sender);
        await this.db.query(`UPDATE notifications SET state='sent', provider=$2, provider_reference=$3, attempts=attempts+1, sent_at=now() WHERE id=$1`, [row!.id, p.name, r.providerRef]);
        return;
      } catch (e) {
        lastErr = e;
        this.log.warn(`SMS route ${p.name} failed: ${(e as Error).message}`);
      }
    }
    await this.db.query(`UPDATE notifications SET state='failed', attempts=attempts+1, error=$2 WHERE id=$1`, [row!.id, String((lastErr as Error)?.message ?? lastErr).slice(0, 300)]);
    throw E.unavailable('sms_unavailable', 'Could not send the SMS right now. Please try again shortly.');
  }

  /** Non-secret transactional messages are queued so provider slowness never blocks API calls. */
  async queueTransactional(opts: { phoneEnc?: string; userId: string; template: string; locale: string; params: Record<string, string | number>; eventId?: string }): Promise<void> {
    const user = await this.db.one<{ phone_enc: string }>('SELECT phone_enc FROM users WHERE id = $1', [opts.userId]);
    if (!user) return;
    const row = await this.db.one<{ id: string }>(
      `INSERT INTO notifications (recipient_user_id, recipient_phone_enc, channel, template, locale, params, event_id)
       VALUES ($1, $2, 'sms', $3, $4, $5::jsonb, $6) RETURNING id`,
      [opts.userId, user.phone_enc, opts.template, opts.locale, JSON.stringify(opts.params), opts.eventId ?? null]);
    await this.queues.add(QUEUES.notify, 'send', { notificationId: row!.id }, { attempts: 4 });
  }

  /** Worker handler for queued notifications. Erases the stored phone after delivery (data minimisation). */
  async deliverQueued(notificationId: string): Promise<void> {
    const n = await this.db.one<any>('SELECT * FROM notifications WHERE id = $1 AND state = \'queued\'', [notificationId]);
    if (!n) return;
    const phone = this.crypto.decrypt(n.recipient_phone_enc);
    const text = await this.render(n.template, n.locale, n.params);
    const sender = await this.sender();
    let lastErr: unknown;
    for (const p of this.providers) {
      try {
        const r = await p.send(phone, text, sender);
        await this.db.query(`UPDATE notifications SET state='sent', provider=$2, provider_reference=$3, attempts=attempts+1, sent_at=now(), recipient_phone_enc=NULL WHERE id=$1`, [n.id, p.name, r.providerRef]);
        return;
      } catch (e) { lastErr = e; }
    }
    await this.db.query(`UPDATE notifications SET attempts=attempts+1, error=$2 WHERE id=$1`, [n.id, String((lastErr as Error)?.message).slice(0, 300)]);
    throw lastErr;
  }

  async smsUsage(days = 30) {
    return this.db.many(
      `SELECT date_trunc('day', created_at)::date AS day, count(*)::int AS total,
              count(*) FILTER (WHERE state='failed')::int AS failed, provider
         FROM notifications WHERE channel='sms' AND created_at > now() - ($1 || ' days')::interval
         GROUP BY 1, provider ORDER BY 1 DESC`, [String(days)]);
  }
}
