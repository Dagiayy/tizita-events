import { Inject, Injectable } from '@nestjs/common';
import sharp from 'sharp';
import { AppConfig, CONFIG } from '../common/config';

export type DetectedMime = 'image/jpeg' | 'image/png' | 'image/webp' | 'image/heic' | 'image/heif';

/** Magic-byte sniffing. The client-declared MIME type and filename are never trusted. */
export function sniffMime(buf: Buffer): DetectedMime | null {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (buf.toString('ascii', 4, 8) === 'ftyp') {
    const brand = buf.toString('ascii', 8, 12);
    if (['heic', 'heix', 'hevc', 'hevx'].includes(brand)) return 'image/heic';
    if (['mif1', 'msf1', 'heim', 'heis'].includes(brand)) return 'image/heif';
  }
  return null;
}

export interface ImageFacts {
  width: number; height: number; orientation: number | null; capturedAt: Date | null; format: string;
}
export interface Derivative { variant: 'thumb' | 'gallery' | 'viewer'; buffer: Buffer; width: number; height: number }

/** Thrown for deterministic problems (not retried): bad image, too many pixels, undecodable. */
export class MediaRejected extends Error {
  constructor(public readonly code: string, message?: string) { super(message ?? code); }
}

@Injectable()
export class ImageService {
  constructor(@Inject(CONFIG) private readonly cfg: AppConfig) {}

  /**
   * Converts HEIC/HEIF to JPEG (sharp's prebuilt libvips usually lacks an HEVC decoder). Done in-process with a
   * WASM decoder: no photo ever leaves the platform.
   */
  async normalizeInput(buf: Buffer, mime: DetectedMime): Promise<{ working: Buffer; converted: boolean }> {
    if (mime !== 'image/heic' && mime !== 'image/heif') return { working: buf, converted: false };
    try {
      await sharp(buf, { limitInputPixels: this.cfg.MEDIA_MAX_PIXELS }).metadata().then(async (m) => { if (!m.width) throw new Error('no-heif'); await sharp(buf).resize(8).toBuffer(); });
      return { working: buf, converted: false };
    } catch { /* fall through to wasm decoder */ }
    try {
      const convert = (await import('heic-convert')).default as (o: { buffer: Buffer; format: 'JPEG'; quality: number }) => Promise<ArrayBuffer>;
      const out = await convert({ buffer: buf, format: 'JPEG', quality: 0.95 });
      return { working: Buffer.from(out), converted: true };
    } catch { throw new MediaRejected('decode_failed', 'HEIC image could not be decoded'); }
  }

  /** Decode safety + metadata extraction. Pixel limit protects against decompression bombs. */
  async inspect(buf: Buffer): Promise<ImageFacts> {
    let meta: sharp.Metadata;
    try {
      meta = await sharp(buf, { limitInputPixels: this.cfg.MEDIA_MAX_PIXELS, failOn: 'error', sequentialRead: true }).metadata();
      // a full decode of a tiny proxy proves the pixel data is valid, not just the header
      await sharp(buf, { limitInputPixels: this.cfg.MEDIA_MAX_PIXELS, failOn: 'error', sequentialRead: true }).resize(32, 32, { fit: 'inside' }).toBuffer();
    } catch (e) {
      const msg = (e as Error).message ?? '';
      if (/pixel limit/i.test(msg)) throw new MediaRejected('too_many_pixels', 'Image dimensions exceed the allowed limit');
      throw new MediaRejected('decode_failed', 'Image could not be decoded');
    }
    if (!meta.width || !meta.height) throw new MediaRejected('decode_failed', 'Image has no dimensions');
    const orientation = meta.orientation ?? null;
    const swap = orientation !== null && orientation >= 5;
    let capturedAt: Date | null = null;
    try {
      if (meta.exif) {
        const exifReader = (await import('exif-reader')).default as (b: Buffer) => any;
        const ex = exifReader(meta.exif);
        const d = ex?.Photo?.DateTimeOriginal ?? ex?.Image?.DateTime;
        if (d instanceof Date && !isNaN(d.getTime()) && d.getFullYear() > 1990 && d < new Date(Date.now() + 86400_000)) capturedAt = d;
      }
    } catch { /* EXIF is optional */ }
    return { width: swap ? meta.height : meta.width, height: swap ? meta.width : meta.height, orientation, capturedAt, format: meta.format ?? 'unknown' };
  }

  /** 64-bit difference hash (dHash) for near-duplicate detection. Returned as signed bigint string for Postgres bigint. */
  async perceptualHash(buf: Buffer): Promise<string> {
    const px = await sharp(buf, { limitInputPixels: this.cfg.MEDIA_MAX_PIXELS, sequentialRead: true }).rotate().greyscale().resize(9, 8, { fit: 'fill' }).raw().toBuffer();
    let bits = 0n;
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) bits = (bits << 1n) | (px[y * 9 + x] > px[y * 9 + x + 1] ? 1n : 0n);
    return BigInt.asIntN(64, bits).toString();
  }

  /**
   * Public derivatives. sharp strips ALL metadata (EXIF incl. GPS, XMP, IPTC, maker notes) unless withMetadata()
   * is requested, which we never do. Orientation is baked in via rotate() before stripping.
   */
  async derivatives(buf: Buffer, opts: { watermarkText?: string | null }): Promise<Derivative[]> {
    const sizes: [Derivative['variant'], number][] = [['thumb', this.cfg.DERIV_THUMB_PX], ['gallery', this.cfg.DERIV_GALLERY_PX], ['viewer', this.cfg.DERIV_VIEWER_PX]];
    const out: Derivative[] = [];
    for (const [variant, px] of sizes) {
      let img = sharp(buf, { limitInputPixels: this.cfg.MEDIA_MAX_PIXELS, failOn: 'error' }).rotate().resize({ width: px, height: px, fit: 'inside', withoutEnlargement: true });
      const { data, info } = await img.toColourspace('srgb').jpeg({ quality: this.cfg.DERIV_JPEG_QUALITY, progressive: true, mozjpeg: false }).toBuffer({ resolveWithObject: true });
      let finalBuf = data;
      if (opts.watermarkText && variant !== 'thumb') finalBuf = await this.watermark(data, info.width, info.height, opts.watermarkText);
      out.push({ variant, buffer: finalBuf, width: info.width, height: info.height });
    }
    return out;
  }

  private async watermark(jpeg: Buffer, w: number, h: number, label: string): Promise<Buffer> {
    const size = Math.max(14, Math.round(Math.min(w, h) / 28));
    const text = escapeXml(truncate(label, 60));
    const svg = `<svg width="${w}" height="${Math.round(size * 2.2)}" xmlns="http://www.w3.org/2000/svg"><style>text{font-family:'Noto Sans','Noto Sans Ethiopic',sans-serif;font-size:${size}px;fill:#fff;fill-opacity:.85;stroke:#000;stroke-opacity:.35;stroke-width:1px;paint-order:stroke}</style><text x="${w - size}" y="${Math.round(size * 1.5)}" text-anchor="end">${text}</text></svg>`;
    return sharp(jpeg).composite([{ input: Buffer.from(svg), gravity: 'southeast' }]).jpeg({ quality: this.cfg.DERIV_JPEG_QUALITY, progressive: true }).toBuffer();
  }
}

const escapeXml = (s: string) => s.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]!));
const truncate = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
