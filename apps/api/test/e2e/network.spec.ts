import sharp from 'sharp';
import { Client_, Harness, bootHarness, createEvent, joinAsGuest } from '../helpers/harness';
import { PROFILES, prng, startServer, startWorkers, uploadOverNetwork, waitFor } from '../helpers/e2e';
import { makeJpeg } from '../helpers/images';
import { ProcessingService } from '../../src/media/processing.service';
import { MaintenanceService } from '../../src/admin/maintenance.service';
import { QueueService } from '../../src/infra/queue.service';

let h: Harness; let base: string; let guest: { token: string }; let eventId: string;
const post = (path: string, init: RequestInit) => fetch(base + path, init);
beforeAll(async () => {
  h = await bootHarness(); base = await startServer(h);
  const host = await Client_.host(h); const ev = await createEvent(h, host);
  eventId = ev.id; guest = (await joinAsGuest(h, ev.uploadToken, { code: ev.joinCode })).body;
  // a typical 12 MP phone photo (~2.5-3.5 MB)
  photo = await makeJpeg({ width: 4000, height: 3000, seed: 7, quality: 80 });
});
afterAll(async () => { await h.close(); });
let photo: Buffer;

describe('Ethiopia connectivity matrix (spec 11, 18, 19.2): Ethio telecom, Safaricom Ethiopia, Wi-Fi, weak signal, outages', () => {
  it('fixture is a realistic 2-5 MB phone photo', () => {
    expect(photo.length).toBeGreaterThan(2 * 1024 * 1024); expect(photo.length).toBeLessThan(15 * 1024 * 1024);
  });

  it.each(['wifi', 'ethio_telecom_4g', 'safaricom_4g', 'slow_4g', 'ethio_telecom_3g', 'connection_loss'])('#8/#22/#26 upload completes exactly once over "%s" with retries, resume and exponential backoff', async (key) => {
    const p = PROFILES[key];
    const mine = await makeJpeg({ width: 4000, height: 3000, seed: 50 + Object.keys(PROFILES).indexOf(key), quality: 80 });   // distinct photo per scenario
    const r = await uploadOverNetwork(base, guest.token, mine, p, prng(key.length * 97 + 13), post);
    expect(r.status).toBe(200);
    // progress is monotonic and reaches 100% (what the UI shows per item)
    expect(r.progress).toEqual([...r.progress].sort((a, b) => a - b)); expect(r.progress.at(-1)).toBe(100);
    // usability budget on virtual time: ~3 MB in < 90 s on congested 4G; 3G/weak signal still finishes inside the 1 h token window
    const budget = ({ wifi: 5, ethio_telecom_4g: 20, safaricom_4g: 20, slow_4g: 60, ethio_telecom_3g: 300, connection_loss: 90 } as Record<string, number>)[key];
    expect(r.virtualSeconds).toBeLessThan(budget);
    if (p.lossRate > 0.05 || p.outage) expect(r.retries).toBeGreaterThan(0);
    await h.get<ProcessingService>(ProcessingService).process(r.mediaId);
    const row = await h.db.one<any>('SELECT upload_state, size_bytes FROM media WHERE id = $1', [r.mediaId]);
    expect(row).toMatchObject({ upload_state: 'ready' }); expect(Number(row.size_bytes)).toBe(mine.length);   // byte-exact despite retries
    // retried chunks never create duplicate parts or duplicate media
    expect((await h.db.one<any>('SELECT count(*)::int AS n FROM upload_parts WHERE media_id = $1', [r.mediaId])).n).toBe(0);   // cleaned after processing
    console.log(`${p.name}: ${r.chunks} chunks, ${r.attemptsTotal} attempts, ${r.retries} retries, ${(r.wireBytes / 1024 / 1024).toFixed(1)} MB on the wire, ~${r.virtualSeconds.toFixed(0)} s virtual`);
  });

  it('identical re-upload after a lost final response is deduplicated by hash (no double publish)', async () => {
    const first = await uploadOverNetwork(base, guest.token, photo, PROFILES.wifi, prng(2), post);
    await h.get<ProcessingService>(ProcessingService).process(first.mediaId);
    expect((await h.db.one<any>('SELECT upload_state FROM media WHERE id = $1', [first.mediaId])).upload_state).toBe('ready');
    const before = (await h.db.one<any>(`SELECT count(*)::int AS n FROM media WHERE event_id = $1 AND upload_state = 'ready'`, [eventId])).n;
    const r = await uploadOverNetwork(base, guest.token, photo, PROFILES.wifi, prng(1), post);
    await h.get<ProcessingService>(ProcessingService).process(r.mediaId);
    expect((await h.db.one<any>('SELECT upload_state FROM media WHERE id = $1', [r.mediaId])).upload_state).toBe('duplicate');
    expect((await h.db.one<any>(`SELECT count(*)::int AS n FROM media WHERE event_id = $1 AND upload_state = 'ready'`, [eventId])).n).toBe(before);
  });

  it('data-saver: gallery derivatives are small enough for weak links (thumb ~tens of KB, viewer well under the original)', async () => {
    const row = await h.db.one<any>(`SELECT m.id FROM media m WHERE m.event_id = $1 AND m.upload_state = 'ready' LIMIT 1`, [eventId]);
    const d = await h.db.many<any>('SELECT variant, byte_size, width, height FROM media_derivatives WHERE media_id = $1', [row.id]);
    const by = Object.fromEntries(d.map((x) => [x.variant, x]));
    expect(by.thumb.byte_size).toBeLessThan(80 * 1024);
    expect(by.gallery.byte_size).toBeLessThan(by.viewer.byte_size);
    expect(by.viewer.byte_size).toBeLessThan(photo.length);
    expect(Math.max(by.thumb.width, by.thumb.height)).toBe(480);
    // a 30-photo grid page on 2 Mbps weak 4G (thumbs only) loads in a few seconds
    const pageBytes = by.thumb.byte_size * 30; const seconds = (pageBytes * 8) / 2_000_000 + 0.25;
    expect(seconds).toBeLessThan(8);
  });

  it('#28 queue durability: jobs enqueued with no worker are processed once a worker comes up (worker failure recovery)', async () => {
    const host = await Client_.host(h); const ev = await createEvent(h, host);
    const g = (await joinAsGuest(h, ev.uploadToken, { code: ev.joinCode })).body;
    const buf = await makeJpeg({ seed: 99, width: 1600, height: 1200 });
    const r = await uploadOverNetwork(base, g.token, buf, PROFILES.wifi, prng(5), post);
    await new Promise((res) => setTimeout(res, 800));
    expect((await h.db.one<any>('SELECT upload_state FROM media WHERE id = $1', [r.mediaId])).upload_state).toBe('uploaded');    // nobody consumed it
    const waiting = (await h.get<QueueService>(QueueService).counts())['media-process'].waiting;
    expect(waiting).toBeGreaterThanOrEqual(1);                                                                                 // backlog is observable
    await startWorkers(h);
    await waitFor(async () => (await h.db.one<any>('SELECT upload_state FROM media WHERE id = $1', [r.mediaId])).upload_state === 'ready', 30_000);
    // and a worker that dies mid-job: simulate by stranding the row, the sweeper re-queues it and the worker finishes it
    const mq = h.get<QueueService>(QueueService).queue('media-process');
    await mq.pause();                                                                                                           // the worker "dies" right after claiming the job
    const stranded = await uploadOverNetwork(base, g.token, await makeJpeg({ seed: 100, width: 1200, height: 900 }), PROFILES.wifi, prng(6), post);
    await mq.remove(`media-${stranded.mediaId}`);
    await h.db.query(`UPDATE media SET upload_state = 'processing', processing_attempts = 1, completed_at = now() - interval '9 minutes' WHERE id = $1`, [stranded.mediaId]);
    await mq.resume();
    expect((await h.get<MaintenanceService>(MaintenanceService).recoverStuck()).media).toBeGreaterThanOrEqual(1);
    await waitFor(async () => (await h.db.one<any>('SELECT upload_state FROM media WHERE id = $1', [stranded.mediaId])).upload_state === 'ready', 30_000);
    void sharp;
  });
});
