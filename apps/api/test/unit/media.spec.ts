import exifReader from 'exif-reader';
import sharp from 'sharp';
import { loadConfig } from '../../src/common/config';
import { ImageService, MediaRejected, sniffMime } from '../../src/media/image.service';
import { EICAR_TEST_STRING, ScanService } from '../../src/media/scan.service';
import { makeJpeg, makePng, makeWebp } from '../helpers/images';

const cfg = loadConfig({ NODE_ENV: 'test' } as any);
const images = new ImageService(cfg);

describe('magic-byte sniffing (client MIME is never trusted)', () => {
  it('detects real formats', async () => {
    expect(sniffMime(await makeJpeg())).toBe('image/jpeg');
    expect(sniffMime(await makePng())).toBe('image/png');
    expect(sniffMime(await makeWebp())).toBe('image/webp');
    const heic = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypheic'), Buffer.alloc(20)]);
    expect(sniffMime(heic)).toBe('image/heic');
  });
  it('rejects fake images: executable, script, text, PDF, truncated', () => {
    expect(sniffMime(Buffer.from('MZ' + 'x'.repeat(100)))).toBeNull();
    expect(sniffMime(Buffer.from('<?php system($_GET[1]); ?>' + ' '.repeat(40)))).toBeNull();
    expect(sniffMime(Buffer.from('%PDF-1.7 ' + 'x'.repeat(40)))).toBeNull();
    expect(sniffMime(Buffer.from('GIF89a' + 'x'.repeat(40)))).toBeNull();
    expect(sniffMime(Buffer.from([0xff, 0xd8]))).toBeNull();
  });
});

describe('derivatives (acceptance #19: public derivatives contain no GPS EXIF)', () => {
  it('source has GPS, every derivative has NO metadata at all', async () => {
    const src = await makeJpeg({ gps: true, width: 3000, height: 2000 });
    const srcMeta = await sharp(src).metadata();
    const srcExif = exifReader(srcMeta.exif!);
    expect(srcExif.GPSInfo?.GPSLatitude).toBeDefined();                    // proves the fixture really carries GPS
    expect(srcExif.Image?.Make).toBe('TestCam');

    const facts = await images.inspect(src);
    expect(facts.width).toBe(3000);
    expect(facts.capturedAt?.getUTCFullYear()).toBe(2026);

    const ds = await images.derivatives(src, { watermarkText: null });
    expect(ds.map((d) => d.variant)).toEqual(['thumb', 'gallery', 'viewer']);
    expect(Math.max(ds[0].width, ds[0].height)).toBe(480);
    expect(Math.max(ds[1].width, ds[1].height)).toBe(1280);
    expect(Math.max(ds[2].width, ds[2].height)).toBe(2560);
    for (const d of ds) {
      const m = await sharp(d.buffer).metadata();
      expect(m.exif).toBeUndefined();
      expect(m.xmp).toBeUndefined();
      expect(m.iptc).toBeUndefined();
      expect(d.buffer.includes(Buffer.from('TestCam'))).toBe(false);
      expect(d.buffer.includes(Buffer.from('GPS'))).toBe(false);
      expect(m.format).toBe('jpeg');
    }
  });
  it('never upscales small photos and bakes in EXIF orientation', async () => {
    const src = await makeJpeg({ width: 400, height: 300, orientation: 6 });
    const facts = await images.inspect(src);
    expect([facts.width, facts.height]).toEqual([300, 400]);       // swapped for orientation 6
    const [thumb, , viewer] = await images.derivatives(src, { watermarkText: null });
    expect([thumb.width, thumb.height]).toEqual([300, 400]);
    expect([viewer.width, viewer.height]).toEqual([300, 400]);
    expect((await sharp(viewer.buffer).metadata()).orientation).toBeUndefined();
  });
  it('watermark (Ethiopic text) keeps output valid and metadata-free', async () => {
    const src = await makeJpeg({ gps: true });
    const ds = await images.derivatives(src, { watermarkText: 'ሠርግ አበበ & ሰላም' });
    const m = await sharp(ds[1].buffer).metadata();
    expect(m.exif).toBeUndefined();
    expect(m.width).toBe(ds[1].width);
  });
});

describe('perceptual hash', () => {
  it('identical and re-encoded copies are near; different photos are far', async () => {
    const a = await makeJpeg({ seed: 3, width: 800, height: 600 });
    const aRe = await sharp(a).resize(400).jpeg({ quality: 60 }).toBuffer();
    const b = await makeJpeg({ seed: 99, width: 800, height: 600 });
    const ham = (x: string, y: string) => { let v = BigInt.asUintN(64, BigInt(x)) ^ BigInt.asUintN(64, BigInt(y)); let n = 0; while (v) { n += Number(v & 1n); v >>= 1n; } return n; };
    const ha = await images.perceptualHash(a); const hr = await images.perceptualHash(aRe); const hb = await images.perceptualHash(b);
    expect(ham(ha, hr)).toBeLessThanOrEqual(5);
    expect(ham(ha, hb)).toBeGreaterThan(5);
    expect(() => BigInt(ha)).not.toThrow();
  });
});

describe('decode safety', () => {
  it('rejects garbage that has a valid JPEG header', async () => {
    const bad = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(500, 7)]);
    await expect(images.inspect(bad)).rejects.toBeInstanceOf(MediaRejected);
  });
  it('rejects decompression bombs via the pixel limit', async () => {
    const strict = new ImageService({ ...cfg, MEDIA_MAX_PIXELS: 10_000 });
    await expect(strict.inspect(await makeJpeg({ width: 400, height: 300 }))).rejects.toMatchObject({ code: 'too_many_pixels' });
  });
});

describe('malware scanning', () => {
  it('flags the EICAR test file and passes clean photos (fails closed by design for clamd)', async () => {
    const scan = new ScanService(cfg);
    expect((await scan.scan(Buffer.concat([Buffer.from('JFIF'), Buffer.from(EICAR_TEST_STRING)]))).clean).toBe(false);
    expect((await scan.scan(await makeJpeg())).clean).toBe(true);
  });
  it('clamd mode with an unreachable scanner throws instead of passing the file', async () => {
    const scan = new ScanService({ ...cfg, AV_MODE: 'clamd', CLAMD_HOST: '127.0.0.1', CLAMD_PORT: 1 });
    await expect(scan.scan(Buffer.from('x'))).rejects.toThrow(/clamd/);
  });
});
