import { defineConfig, devices } from '@playwright/test';

/**
 * Browser end-to-end tests. They expect the stack to be running (see docs/TESTING.md):
 *   API on :4000 (NODE_ENV=development, OTP_FIXED_CODE=123456, PAYMENT_PROVIDER=sandbox) and web on :3000.
 * Uses the installed Microsoft Edge (Chromium) so no browser download is required; set PW_CHANNEL=chrome or unset to use bundled Chromium.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 120_000,
  expect: { timeout: 15_000 },
  workers: 1,
  reporter: [['list']],
  use: { baseURL: process.env.WEB_URL ?? 'http://localhost:3000', trace: 'retain-on-failure', screenshot: 'only-on-failure', channel: process.env.PW_CHANNEL ?? 'msedge' },
  projects: [
    { name: 'android-chrome', use: { ...devices['Pixel 5'], channel: process.env.PW_CHANNEL ?? 'msedge' } },
    { name: 'desktop', use: { ...devices['Desktop Chrome'], channel: process.env.PW_CHANNEL ?? 'msedge' }, testMatch: /(host|admin)\.spec\.ts/ },
  ],
});
