/**
 * Smoke check of the real ClamAV integration:  AV_MODE=clamd CLAMD_HOST=localhost npx ts-node --transpile-only scripts/clamd-check.ts
 * Verifies PING, a clean image, the EICAR test file, and that an unreachable scanner fails closed.
 */
import sharp from 'sharp';
import { loadConfig } from '../src/common/config';
import { EICAR_TEST_STRING, ScanService } from '../src/media/scan.service';

async function main() {
  const cfg = loadConfig({ ...process.env, NODE_ENV: 'development', AV_MODE: 'clamd' } as any);
  const scan = new ScanService(cfg);
  console.log('ping:', await scan.ping());
  const jpeg = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#336699' } }).jpeg().toBuffer();
  console.log('clean image  ->', await scan.scan(jpeg));
  // ClamAV matches the standard EICAR file by exact content, so scan it standalone (no JPEG prefix)
  console.log('EICAR file   ->', await scan.scan(Buffer.from(EICAR_TEST_STRING)));
  const dead = new ScanService({ ...cfg, CLAMD_PORT: 1 });
  await dead.scan(jpeg).then(() => console.log('unreachable -> PASSED (BUG)'), (e) => console.log('unreachable -> fail-closed:', (e as Error).message));
}
main().catch((e) => { console.error(e); process.exit(1); });
