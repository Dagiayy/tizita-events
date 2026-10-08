/**
 * Creates (or promotes) a platform staff account. Staff sign in with +251 OTP and MUST enrol an authenticator app on first login
 * (admin 2FA is mandatory). Usage:
 *   npm run admin:bootstrap -- +251911000001 super_admin
 *   npm run admin:bootstrap -- +251911000002 support_agent
 */
import { AuditService } from '../src/audit/audit.service';
import { loadConfig } from '../src/common/config';
import { CryptoService } from '../src/common/crypto';
import { normalizeEthiopianPhone } from '../src/common/phone';
import { Db } from '../src/infra/db.service';

async function main() {
  const [phoneArg, roleArg = 'super_admin'] = process.argv.slice(2);
  const phone = normalizeEthiopianPhone(phoneArg ?? '');
  if (!phone) throw new Error('Provide an Ethiopian mobile number, e.g. +251911000001');
  if (!['super_admin', 'support_agent'].includes(roleArg)) throw new Error('role must be super_admin or support_agent');
  const cfg = loadConfig();
  const crypto = new CryptoService(cfg);
  const db = new Db(cfg);
  try {
    const r = await db.one<{ id: string }>(
      `INSERT INTO users (phone_hash, phone_enc, phone_last4, platform_role) VALUES ($1,$2,$3,$4)
       ON CONFLICT (phone_hash) DO UPDATE SET platform_role = EXCLUDED.platform_role RETURNING id`,
      [crypto.hmac(phone, 'phone'), crypto.encrypt(phone), phone.slice(-4), roleArg]);
    await new AuditService(db).record({ action: 'admin.bootstrap', resourceType: 'user', resourceId: r!.id, actor: { type: 'system' }, after: { role: roleArg } });
    console.log(`Staff account ready: ${phone} as ${roleArg}. Sign in with OTP, then enrol 2FA via POST /v1/auth/2fa/enroll.`);
  } finally { await db.onModuleDestroy(); }
}
main().catch((e) => { console.error(e.message); process.exit(1); });
