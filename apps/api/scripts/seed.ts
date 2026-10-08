/**
 * Development seed: creates a super admin and a support agent so the admin console can be explored locally.
 * Reference data (plans, system settings, policy drafts, vendor register) is created by migration 002 - not here.
 *   npm run seed
 * Sign in at http://localhost:3000/admin with +251911000001 (OTP appears in the API log when SMS_PROVIDERS=console,
 * or use OTP_FIXED_CODE=123456 in your LOCAL .env - the API refuses that setting in production).
 */
import { AuditService } from '../src/audit/audit.service';
import { loadConfig } from '../src/common/config';
import { CryptoService } from '../src/common/crypto';
import { Db } from '../src/infra/db.service';
import { runMigrations } from '../src/infra/migrate';

async function main() {
  const cfg = loadConfig();
  if (cfg.isProd) throw new Error('Refusing to seed demo accounts in production');
  await runMigrations(cfg.DATABASE_URL);
  const crypto = new CryptoService(cfg); const db = new Db(cfg);
  try {
    for (const [phone, role] of [['+251911000001', 'super_admin'], ['+251911000002', 'support_agent']] as const) {
      const r = await db.one<{ id: string }>(
        `INSERT INTO users (phone_hash, phone_enc, phone_last4, platform_role) VALUES ($1,$2,$3,$4)
         ON CONFLICT (phone_hash) DO UPDATE SET platform_role = EXCLUDED.platform_role RETURNING id`,
        [crypto.hmac(phone, 'phone'), crypto.encrypt(phone), phone.slice(-4), role]);
      await new AuditService(db).record({ action: 'admin.seed', resourceType: 'user', resourceId: r!.id, actor: { type: 'system' }, after: { role } });
      console.log(`staff ready: ${phone} (${role}) - enrol 2FA on first sign-in`);
    }
  } finally { await db.onModuleDestroy(); }
}
main().catch((e) => { console.error(e.message); process.exit(1); });
