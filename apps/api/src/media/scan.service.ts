import { Inject, Injectable } from '@nestjs/common';
import * as net from 'net';
import { AppConfig, CONFIG } from '../common/config';

export interface ScanResult { clean: boolean; signature?: string }

/** Standard anti-malware test string (EICAR). Dev/test mode only. */
const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';

/**
 * Malware scanning before publication. Production uses ClamAV (clamd INSTREAM) running on the same
 * Ethiopia-hosted network. The scan FAILS CLOSED: if the scanner is unreachable the job errors and is
 * retried - an unscanned file is never published.
 */
@Injectable()
export class ScanService {
  constructor(@Inject(CONFIG) private readonly cfg: AppConfig) {}

  async scan(buf: Buffer): Promise<ScanResult> {
    if (this.cfg.AV_MODE === 'eicar') return buf.includes(Buffer.from(EICAR)) ? { clean: false, signature: 'Eicar-Test-Signature' } : { clean: true };
    return this.clamd(buf);
  }

  private clamd(buf: Buffer): Promise<ScanResult> {
    return new Promise((resolve, reject) => {
      const sock = net.connect({ host: this.cfg.CLAMD_HOST, port: this.cfg.CLAMD_PORT });
      const chunks: Buffer[] = [];
      sock.setTimeout(30_000, () => { sock.destroy(); reject(new Error('clamd timeout')); });
      sock.on('error', (e) => reject(new Error(`clamd unavailable: ${e.message}`)));
      sock.on('data', (d) => chunks.push(d));
      sock.on('end', () => {
        const reply = Buffer.concat(chunks).toString('utf8').replace(/\0/g, '').trim();
        if (/OK$/.test(reply)) return resolve({ clean: true });
        const m = /stream: (.+) FOUND$/.exec(reply);
        if (m) return resolve({ clean: false, signature: m[1] });
        reject(new Error(`clamd unexpected reply: ${reply.slice(0, 120)}`));
      });
      sock.on('connect', () => {
        sock.write('zINSTREAM\0');
        const CH = 64 * 1024;
        for (let i = 0; i < buf.length; i += CH) {
          const part = buf.subarray(i, Math.min(i + CH, buf.length));
          const len = Buffer.alloc(4); len.writeUInt32BE(part.length);
          sock.write(len); sock.write(part);
        }
        sock.write(Buffer.alloc(4)); // zero-length terminator
      });
    });
  }

  async ping(): Promise<boolean> {
    if (this.cfg.AV_MODE === 'eicar') return true;
    return new Promise((resolve) => {
      const s = net.connect({ host: this.cfg.CLAMD_HOST, port: this.cfg.CLAMD_PORT });
      s.setTimeout(3000, () => { s.destroy(); resolve(false); });
      s.on('error', () => resolve(false));
      s.on('connect', () => s.write('zPING\0'));
      s.on('data', (d) => { s.end(); resolve(d.toString().includes('PONG')); });
    });
  }
}
export const EICAR_TEST_STRING = EICAR;
