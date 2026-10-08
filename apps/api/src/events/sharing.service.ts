import { Inject, Injectable } from '@nestjs/common';
import * as fs from 'fs';
import PDFDocument from 'pdfkit';
import sharp from 'sharp';
import * as QRCode from 'qrcode';
import { AuditService } from '../audit/audit.service';
import { AppConfig, CONFIG } from '../common/config';
import { CryptoService, randomToken } from '../common/crypto';
import { E } from '../common/errors';
import { gregorianToEthiopian, ETHIOPIAN_MONTHS_AM, ETHIOPIAN_MONTHS_EN } from '../common/ethiopic-calendar';
import { Principal } from '../common/request-context';
import { Db } from '../infra/db.service';
import { AccessService } from './access.service';
import { EventsService } from './events.service';
import { assertAllowed } from './lifecycle';

export type SecretType = 'upload_token' | 'gallery_token' | 'join_code' | 'passcode';

const FONT_DIR = (() => {
  try { return require('path').dirname(require.resolve('@fontsource/noto-sans-ethiopic/package.json')) + '/files'; } catch { return null; }
})();
const LATIN_DIR = (() => {
  try { return require('path').dirname(require.resolve('@fontsource/noto-sans/package.json')) + '/files'; } catch { return null; }
})();
const ETHIOPIC = /[ሀ-᎟ⶀ-⷟꬀-꬯]/;

@Injectable()
export class SharingService {
  constructor(
    private readonly db: Db,
    private readonly access: AccessService,
    private readonly crypto: CryptoService,
    private readonly audit: AuditService,
    private readonly events: EventsService,
    @Inject(CONFIG) private readonly cfg: AppConfig,
  ) {}

  private async tokenOf(eventId: string, type: SecretType): Promise<string | null> {
    const r = await this.db.one<{ token_enc: string | null }>(
      'SELECT token_enc FROM access_secrets WHERE event_id = $1 AND secret_type = $2 AND revoked_at IS NULL', [eventId, type]);
    return r?.token_enc ? this.crypto.decrypt(r.token_enc) : null;
  }

  linkFor(token: string, code?: string | null): string {
    return `${this.cfg.PUBLIC_WEB_URL.replace(/\/$/, '')}/j/${token}${code ? `?c=${encodeURIComponent(code)}` : ''}`;
  }

  /** Separate upload and gallery links/codes (spec 7.1). Only the owner/moderators can read them. */
  async shareLinks(me: Principal, eventId: string) {
    const { event } = await this.access.requireMember(me, eventId, 'event.share');
    assertAllowed(event.state, 'share');
    const [upload, gallery, code] = await Promise.all([this.tokenOf(eventId, 'upload_token'), this.tokenOf(eventId, 'gallery_token'), this.tokenOf(eventId, 'join_code')]);
    const pass = await this.db.one('SELECT 1 FROM access_secrets WHERE event_id = $1 AND secret_type = \'passcode\' AND revoked_at IS NULL', [eventId]);
    return {
      upload_url: upload ? this.linkFor(upload) : null,
      gallery_url: gallery ? this.linkFor(gallery) : null,
      join_code: code, join_code_scope: event.join_code_scope,
      passcode_set: !!pass,
      slideshow_url: gallery && event.slideshow_enabled ? `${this.linkFor(gallery).replace('/j/', '/slideshow/')}` : null,
      upload_access_mode: event.upload_access_mode, gallery_access_mode: event.gallery_access_mode,
    };
  }

  /** Replace a secret (token/code/passcode). Old value stops working immediately. */
  async rotate(me: Principal, eventId: string, body: { type: SecretType; passcode?: string; revoke_sessions?: boolean }) {
    // rotating tokens / the passcode changes event security: owner-only (moderators may view and print links, not change them)
    const { event, userId } = await this.access.requireMember(me, eventId, 'event.update');
    assertAllowed(event.state, 'configure_access');
    let plaintext: string | null = null;
    let tokenHash: string; let tokenEnc: string | null = null;
    if (body.type === 'passcode') {
      if (!body.passcode || body.passcode.length < 4 || body.passcode.length > 64) throw E.unprocessable('invalid_passcode', 'Passcode must be 4-64 characters.');
      tokenHash = await this.crypto.hashSecret(body.passcode);
    } else {
      plaintext = body.type === 'join_code' ? await this.events.uniqueJoinCode(this.db) : (body.type === 'upload_token' ? 'u_' : 'g_') + randomToken(24);
      tokenHash = this.crypto.hmac(plaintext, 'event-token');
      tokenEnc = this.crypto.encrypt(plaintext);
    }
    await this.db.tx(async (c) => {
      await c.query(`UPDATE access_secrets SET revoked_at = now() WHERE event_id = $1 AND secret_type = $2 AND revoked_at IS NULL`, [eventId, body.type]);
      await c.query(`INSERT INTO access_secrets (event_id, secret_type, token_hash, token_enc, created_by) VALUES ($1,$2,$3,$4,$5)`, [eventId, body.type, tokenHash, tokenEnc, userId]);
      if (body.revoke_sessions) {
        const scope = body.type === 'upload_token' ? 'upload' : body.type === 'gallery_token' ? 'gallery' : null;
        if (scope) await c.query(`UPDATE guest_sessions SET scopes = array_remove(scopes, $2) WHERE event_id = $1`, [eventId, scope]);
        else await c.query(`UPDATE guest_sessions SET scopes = '{}' WHERE event_id = $1`, [eventId]);
      }
      await this.audit.record({ action: 'event.secret_rotated', resourceType: 'event', resourceId: eventId, eventId, after: { type: body.type, sessions_revoked: !!body.revoke_sessions } }, c);
    });
    return this.shareLinks(me, eventId);
  }

  // ------------------------------------------------------------ printable QR (PNG / PDF)
  async qr(me: Principal, eventId: string, opts: { kind: 'upload' | 'gallery'; format: 'png' | 'pdf'; include_code?: boolean; size?: number }) {
    const { event } = await this.access.requireMember(me, eventId, 'event.share');
    assertAllowed(event.state, 'share');
    const token = await this.tokenOf(eventId, opts.kind === 'upload' ? 'upload_token' : 'gallery_token');
    if (!token) throw E.notFound('secret_not_found');
    const code = await this.tokenOf(eventId, 'join_code');
    const embedCode = !!opts.include_code && code && (event.join_code_scope === 'both' || event.join_code_scope === opts.kind);
    const url = this.linkFor(token, embedCode ? code : null);
    await this.audit.record({ action: 'event.qr_generated', resourceType: 'event', resourceId: eventId, eventId, after: { kind: opts.kind, format: opts.format, include_code: !!embedCode } });

    if (opts.format === 'png') {
      // SVG -> PNG through libvips (fast, crisp, no pure-JS PNG encoder)
      const svg = await QRCode.toString(url, { type: 'svg', errorCorrectionLevel: 'M', margin: 2 });
      const size = Math.min(Math.max(opts.size ?? 800, 256), 2000);
      const buf = await sharp(Buffer.from(svg), { density: 300 }).resize(size, size, { fit: 'contain', background: '#ffffff', kernel: 'nearest' }).flatten({ background: '#ffffff' }).png({ compressionLevel: 6 }).toBuffer();
      return { contentType: 'image/png', filename: `${opts.kind}-qr.png`, body: buf };
    }
    const qr = QRCode.create(url, { errorCorrectionLevel: 'Q' });
    const pdf = await this.renderCard(event, opts.kind, qr.modules, code && (event.join_code_scope === 'both' || event.join_code_scope === opts.kind) ? code : null);
    return { contentType: 'application/pdf', filename: `${opts.kind}-qr-card.pdf`, body: pdf };
  }

  /** A5 table card. Ethiopic text uses the bundled Noto Sans Ethiopic font; no external font CDN. */
  private renderCard(event: any, kind: 'upload' | 'gallery', modules: { size: number; get(r: number, c: number): number }, code: string | null): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const doc = new PDFDocument({ size: 'A5', margin: 36, info: { Title: `${event.name} - ${kind} QR` } });
      const chunks: Buffer[] = [];
      doc.on('data', (c) => chunks.push(c)); doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject);
      const latin = LATIN_DIR && fs.existsSync(`${LATIN_DIR}/noto-sans-latin-400-normal.woff`) ? `${LATIN_DIR}/noto-sans-latin-400-normal.woff` : null;
      const latinBold = LATIN_DIR && fs.existsSync(`${LATIN_DIR}/noto-sans-latin-700-normal.woff`) ? `${LATIN_DIR}/noto-sans-latin-700-normal.woff` : null;
      const eth = FONT_DIR && fs.existsSync(`${FONT_DIR}/noto-sans-ethiopic-ethiopic-400-normal.woff`) ? `${FONT_DIR}/noto-sans-ethiopic-ethiopic-400-normal.woff` : null;
      const ethBold = FONT_DIR && fs.existsSync(`${FONT_DIR}/noto-sans-ethiopic-ethiopic-700-normal.woff`) ? `${FONT_DIR}/noto-sans-ethiopic-ethiopic-700-normal.woff` : null;
      if (latin) doc.registerFont('L', latin); if (latinBold) doc.registerFont('LB', latinBold);
      if (eth) doc.registerFont('E', eth); if (ethBold) doc.registerFont('EB', ethBold);
      const font = (text: string, bold = false) => (ETHIOPIC.test(text) && eth ? (bold && ethBold ? 'EB' : 'E') : latin ? (bold && latinBold ? 'LB' : 'L') : bold ? 'Helvetica-Bold' : 'Helvetica');
      const W = doc.page.width - 72;
      const text = (s: string, size: number, bold = false, gap = 8) => { doc.font(font(s, bold)).fontSize(size).text(s, { width: W, align: 'center' }); doc.moveDown(gap / size); };

      const am = event.language === 'am';
      doc.rect(18, 18, doc.page.width - 36, doc.page.height - 36).lineWidth(2).stroke(event.brand_color || '#0b6b3a');
      doc.moveDown(1);
      text(event.name, 24, true, 10);
      if (event.host_name) text(event.host_name, 13, false, 6);
      const d = new Date(event.starts_at);
      const eth_d = gregorianToEthiopian(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
      text(`${d.toISOString().slice(0, 10)}  |  ${eth_d.day} ${(am ? ETHIOPIAN_MONTHS_AM : ETHIOPIAN_MONTHS_EN)[eth_d.month - 1]} ${eth_d.year}`, 10, false, 14);
      // vector QR (stays sharp at any print size)
      const side = 220; const quiet = 4; const cell = side / (modules.size + quiet * 2);
      const x0 = (doc.page.width - side) / 2; const y0 = doc.y;
      doc.rect(x0, y0, side, side).fill('#ffffff');
      for (let r = 0; r < modules.size; r++) for (let c = 0; c < modules.size; c++) if (modules.get(r, c)) doc.rect(x0 + (c + quiet) * cell, y0 + (r + quiet) * cell, cell + 0.2, cell + 0.2).fill('#000000');
      doc.fillColor('#000000');
      doc.y = y0 + side + 12;
      const title = kind === 'upload'
        ? (am ? 'ፎቶዎችዎን ለማጋራት ይቃኙ' : 'Scan to share your photos')
        : (am ? 'ማዕከለ ስዕሉን ለማየት ይቃኙ' : 'Scan to view the gallery');
      text(title, 15, true, 8);
      if (code) text(`${am ? 'ኮድ' : 'Code'}: ${code}`, 20, true, 8);
      text(am ? 'ካሜራ የለም? የድር አድራሻውን ይክፈቱ እና ኮዱን ያስገቡ።' : 'No camera? Open the website and enter the code.', 9, false, 4);
      doc.end();
    });
  }
}
