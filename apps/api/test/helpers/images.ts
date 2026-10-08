import sharp from 'sharp';

/** Deterministic pseudo-random but photo-like test image (noise so JPEG isn't trivially tiny). */
export async function makeJpeg(opts: { width?: number; height?: number; seed?: number; gps?: boolean; orientation?: number; quality?: number } = {}): Promise<Buffer> {
  const w = opts.width ?? 640; const h = opts.height ?? 480; const seed = opts.seed ?? 1;
  const raw = Buffer.alloc(w * h * 3);
  let s = seed * 2654435761 >>> 0;
  for (let i = 0; i < raw.length; i += 3) {
    s = (s * 1664525 + 1013904223) >>> 0;
    const x = (i / 3) % w; const y = Math.floor(i / 3 / w);
    raw[i] = ((x * 255) / w + (s >>> 24) / 4 + seed * 17) % 256;
    raw[i + 1] = ((y * 255) / h + ((s >>> 16) & 255) / 4) % 256;
    raw[i + 2] = ((x + y) % 256 + ((s >>> 8) & 255) / 8) % 256;
  }
  let img = sharp(raw, { raw: { width: w, height: h, channels: 3 } });
  const exif: Record<string, Record<string, string>> = { IFD0: { Make: 'TestCam', Model: 'T-1', DateTime: '2026:10:02 14:30:00' }, IFD2: { DateTimeOriginal: '2026:10:02 14:30:00' } };
  if (opts.gps) exif.IFD3 = { GPSLatitudeRef: 'N', GPSLatitude: '9/1 1/1 0/1', GPSLongitudeRef: 'E', GPSLongitude: '38/1 44/1 0/1' };
  img = img.withExif(exif);
  if (opts.orientation) img = img.withMetadata({ orientation: opts.orientation });
  return img.jpeg({ quality: opts.quality ?? 85 }).toBuffer();
}

export async function makePng(w = 300, h = 200): Promise<Buffer> {
  return sharp({ create: { width: w, height: h, channels: 3, background: { r: 40, g: 120, b: 200 } } }).png().toBuffer();
}
export async function makeWebp(w = 300, h = 200): Promise<Buffer> {
  return sharp({ create: { width: w, height: h, channels: 3, background: { r: 200, g: 120, b: 40 } } }).webp().toBuffer();
}
