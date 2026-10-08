import { Inject, Injectable } from '@nestjs/common';
import { AppConfig, CONFIG } from '../common/config';
import { CryptoService } from '../common/crypto';
import { E } from '../common/errors';

export type Variant = 'thumb' | 'gallery' | 'viewer' | 'original';
export type Audience = 'pub' | 'stf' | 'adm';

/**
 * Short-lived HMAC-signed URLs. They reference only opaque ids - never bucket names, object keys or
 * storage credentials - and are verified (and the media's CURRENT state re-checked) on every request.
 */
@Injectable()
export class SignedUrlService {
  constructor(private readonly crypto: CryptoService, @Inject(CONFIG) private readonly cfg: AppConfig) {}

  mediaUrl(mediaId: string, variant: Variant, audience: Audience, opts: { download?: boolean; ttlSec?: number; grant?: string } = {}): string {
    const exp = Math.floor(Date.now() / 1000) + (opts.ttlSec ?? (audience === 'pub' ? this.cfg.SIGNED_URL_TTL_SEC : 600));
    const dl = opts.download ? 1 : 0;
    const g = opts.grant ?? '';
    const sig = this.crypto.sign(`m:${mediaId}:${variant}:${audience}:${exp}:${dl}:${g}`);
    return `${this.cfg.PUBLIC_API_URL}/v1/m/${mediaId}/${variant}?a=${audience}&exp=${exp}&dl=${dl}${g ? `&g=${g}` : ''}&sig=${sig}`;
  }

  verifyMedia(mediaId: string, variant: string, q: { a?: string; exp?: string; dl?: string; g?: string; sig?: string }): { audience: Audience; download: boolean; grant?: string } {
    const exp = Number(q.exp);
    if (!q.sig || !q.a || !Number.isFinite(exp) || !['pub', 'stf', 'adm'].includes(q.a)) throw E.forbidden('invalid_signature');
    if (exp < Math.floor(Date.now() / 1000)) throw E.forbidden('link_expired', 'This link has expired.');
    if (!this.crypto.verifySig(`m:${mediaId}:${variant}:${q.a}:${exp}:${q.dl === '1' ? 1 : 0}:${q.g ?? ''}`, q.sig)) throw E.forbidden('invalid_signature');
    return { audience: q.a as Audience, download: q.dl === '1', grant: q.g || undefined };
  }

  uploadToken(mediaId: string, eventId: string): { token: string; expires_at: string } {
    const exp = Math.floor(Date.now() / 1000) + this.cfg.UPLOAD_TOKEN_TTL_SEC;
    const body = Buffer.from(JSON.stringify({ m: mediaId, e: eventId, x: exp })).toString('base64url');
    return { token: `${body}.${this.crypto.sign(`up:${body}`)}`, expires_at: new Date(exp * 1000).toISOString() };
  }

  verifyUploadToken(token: string | undefined, mediaId: string): { eventId: string } {
    if (!token) throw E.unauthorized('upload_token_required', 'Upload token required.');
    const [body, sig] = token.split('.');
    if (!body || !sig || !this.crypto.verifySig(`up:${body}`, sig)) throw E.unauthorized('invalid_upload_token', 'Invalid upload token.');
    let p: { m: string; e: string; x: number };
    try { p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { throw E.unauthorized('invalid_upload_token'); }
    if (p.m !== mediaId) throw E.unauthorized('invalid_upload_token', 'Invalid upload token.');
    if (p.x < Math.floor(Date.now() / 1000)) throw E.unauthorized('upload_token_expired', 'Upload session expired. Request a new upload intent.');
    return { eventId: p.e };
  }

  exportUrl(exportId: string): { url: string; expires_at: string } {
    const exp = Math.floor(Date.now() / 1000) + this.cfg.EXPORT_LINK_TTL_SEC;
    return { url: `${this.cfg.PUBLIC_API_URL}/v1/exports/${exportId}/file?exp=${exp}&sig=${this.crypto.sign(`x:${exportId}:${exp}`)}`, expires_at: new Date(exp * 1000).toISOString() };
  }
  verifyExport(exportId: string, exp: string | undefined, sig: string | undefined): void {
    const n = Number(exp);
    if (!sig || !Number.isFinite(n) || !this.crypto.verifySig(`x:${exportId}:${n}`, sig)) throw E.forbidden('invalid_signature');
    if (n < Math.floor(Date.now() / 1000)) throw E.forbidden('link_expired', 'This download link has expired.');
  }

  verifyCover(code: string, exp: string | undefined, sig: string | undefined): void {
    const n = Number(exp);
    if (!sig || !Number.isFinite(n) || !this.crypto.verifySig(`cover:${code}:${n}`, sig)) throw E.forbidden('invalid_signature');
    if (n < Math.floor(Date.now() / 1000)) throw E.forbidden('link_expired');
  }
}
