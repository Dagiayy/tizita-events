import { expect, test } from '@playwright/test';
import { FIXED_OTP, apiCall, hostLogin, makeEvent, totp } from './helpers';
import { Client } from 'pg';
import { createHmac } from 'crypto';

/** Platform admin: OTP + mandatory authenticator 2FA, dashboard, event search without media exposure, audited actions. */
test('platform admin: 2FA enrolment, dashboard, event search (metadata only), suspend with step-up', async ({ page }) => {
  // provision a staff user (what `npm run admin:bootstrap` does) directly in the dev DB
  const phone = `09${Math.floor(10000000 + Math.random() * 89999999)}`.slice(0, 10); const e164 = `+251${phone.slice(1)}`;
  const pepper = process.env.HASH_PEPPER ?? 'dev_only_hash_pepper_change_me_0123456789abcdef';
  const phoneHash = createHmac('sha256', pepper).update('phone').update('\0').update(e164).digest('hex');
  const db = new Client({ connectionString: process.env.DATABASE_URL ?? 'postgres://event:event_dev_password@localhost:5433/event' }); await db.connect();
  await db.query(`INSERT INTO users (phone_hash, phone_enc, phone_last4, platform_role) VALUES ($1,'x',$2,'super_admin')`, [phoneHash, e164.slice(-4)]);

  const host = await hostLogin(); const ev = await makeEvent(host.token, { name: 'Admin visible event', city: 'Gondar' });

  await page.goto('/admin');
  await page.getByLabel(/Mobile number/).fill(phone); await page.getByRole('button', { name: 'Send code' }).click();
  await page.getByLabel(/Verification code/).fill(FIXED_OTP); await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Two-factor authentication' })).toBeVisible();                // OTP alone is not enough
  const secret = (await page.locator('code').first().textContent())!.trim();
  await db.query('UPDATE users SET totp_last_step = NULL WHERE phone_hash = $1', [phoneHash]);
  await page.getByLabel('Authenticator code').fill(totp(secret)); await page.getByRole('button', { name: 'Verify' }).click();
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  await expect(page.getByText('Active events')).toBeVisible();
  await expect(page.getByText('Queues')).toBeVisible();

  // search by opaque code: metadata only, masked phone, and a clear "no media" notice
  await page.getByRole('link', { name: 'Events' }).click();
  await page.getByLabel('Event code').fill(ev.id ? (await apiCall<any>('GET', `/events/${ev.id}`, host.token)).body.public_code : '');
  await page.getByRole('button', { name: 'Search' }).click();
  await page.getByRole('cell', { name: 'Admin visible event' }).click();
  await expect(page.getByText(/Photos are not visible here/)).toBeVisible();
  const text = await page.locator('.modal').innerText();
  expect(text).not.toContain(ev.code); expect(text).not.toMatch(/\/j\/[ug]_/);

  // suspend needs a reason AND a fresh authenticator code
  await page.getByLabel('Reason').fill('Reported for abuse, ticket 4411');
  await expect(page.getByRole('button', { name: 'Suspend' })).toBeDisabled();
  await db.query('UPDATE users SET totp_last_step = NULL WHERE phone_hash = $1', [phoneHash]);
  await page.locator('.modal').getByLabel('Authenticator code').fill(totp(secret));
  await page.getByRole('button', { name: 'Suspend' }).click();
  await expect(page.locator('.modal .badge', { hasText: 'suspended' })).toBeVisible();
  expect((await apiCall<any>('GET', `/events/${ev.id}`, host.token)).body.state).toBe('suspended');
  await db.end();

  // audit page shows the privileged action
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('link', { name: 'Audit' }).click();
  await page.getByPlaceholder(/action prefix/).fill('event.state'); await page.getByRole('button', { name: 'Search' }).click();
  await expect(page.getByRole('cell', { name: 'event.state.live_to_suspended' }).first()).toBeVisible();
  await page.getByRole('button', { name: 'Verify chain' }).click();
  await expect(page.getByText(/Audit chain intact/)).toBeVisible();
});

test('non-staff accounts cannot use the admin console', async ({ page }) => {
  const phone = `09${Math.floor(10000000 + Math.random() * 89999999)}`.slice(0, 10);
  await page.goto('/admin');
  await page.getByLabel(/Mobile number/).fill(phone); await page.getByRole('button', { name: 'Send code' }).click();
  await page.getByLabel(/Verification code/).fill(FIXED_OTP); await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByText(/not a platform staff account/)).toBeVisible();
});
