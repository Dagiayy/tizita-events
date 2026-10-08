import { execFileSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Client_, Harness, bootHarness, createEvent, guestUpload, joinAsGuest, photo } from '../helpers/harness';

let h: Harness;
beforeAll(async () => { h = await bootHarness(); });
afterAll(async () => { await h.close(); });

const root = path.resolve(__dirname, '../../../..');
const dockerUp = (() => { try { return spawnSync('docker', ['inspect', '-f', '{{.State.Running}}', 'event-platform-postgres-1']).stdout.toString().trim() === 'true'; } catch { return false; } })();
const bash = (() => { for (const b of ['bash', 'C:\\Program Files\\Git\\bin\\bash.exe']) { try { if (spawnSync(b, ['-c', 'true']).status === 0) return b; } catch { /* next */ } } return null; })();

(dockerUp && bash ? describe : describe.skip)('#27 Backup and restore (encrypted dump -> throwaway DB -> integrity checks)', () => {
  it('backs up the live database, encrypts it, restores it elsewhere and verifies row counts + audit hash chain within the RTO', async () => {
    const host = await Client_.host(h); const ev = await createEvent(h, host);
    const g = (await joinAsGuest(h, ev.uploadToken, { code: ev.joinCode })).body;
    await guestUpload(h, g, await photo(1)); await guestUpload(h, g, await photo(2));
    const expected = {
      users: (await h.db.one<any>('SELECT count(*)::int AS n FROM users')).n, events: (await h.db.one<any>('SELECT count(*)::int AS n FROM events')).n,
      media: (await h.db.one<any>('SELECT count(*)::int AS n FROM media')).n, audit: (await h.db.one<any>('SELECT count(*)::int AS n FROM audit_events')).n,
    };
    expect(expected.media).toBe(2);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bk-'));
    fs.writeFileSync(path.join(dir, 'pass'), 'drill-passphrase-not-a-secret');
    const env = { ...process.env, MSYS_NO_PATHCONV: '1', BACKUP_DIR: path.join(dir, 'primary').replace(/\\/g, '/'), SECONDARY_DIR: path.join(dir, 'secondary').replace(/\\/g, '/'), BACKUP_PASSPHRASE_FILE: path.join(dir, 'pass').replace(/\\/g, '/'),
      PG_CONTAINER: 'event-platform-postgres-1', PGDATABASE: 'event_test', BACKUP_LOCATION_LABEL: 'addis-dc1-test' };
    const sh = (script: string) => execFileSync(bash!, [path.join(root, 'infra/scripts', script).replace(/\\/g, '/')], { env, encoding: 'utf8' });
    const b = sh('backup.sh');
    expect(b).toMatch(/backup ok/);
    const files = fs.readdirSync(path.join(dir, 'primary'));
    const enc = files.find((f) => f.endsWith('.enc'))!;
    const bytes = fs.readFileSync(path.join(dir, 'primary', enc));
    expect(bytes.subarray(0, 8).toString()).toBe('Salted__');                                  // OpenSSL-encrypted, not a plain pg dump
    expect(bytes.includes(Buffer.from('PGDMP'))).toBe(false);
    expect(fs.readdirSync(path.join(dir, 'secondary')).length).toBe(2);                         // second Ethiopian location got a copy

    const r = sh('restore-drill.sh');
    expect(r).toContain(`users=${expected.users}`); expect(r).toContain(`events=${expected.events}`); expect(r).toContain(`media=${expected.media}`);
    expect(r).toMatch(/audit=\d+/); expect(r).toMatch(/restore_seconds=\d+/);
    const secs = Number(/measured database restore: (\d+)s/.exec(r)![1]);
    expect(secs).toBeLessThan(7200);                                                            // RTO <= 2 h
    const run = await h.db.one<any>(`SELECT status, encrypted, verified_at, location_label FROM backup_runs ORDER BY started_at DESC LIMIT 1`);
    expect(run).toMatchObject({ status: 'succeeded', encrypted: true, location_label: 'addis-dc1-test' }); expect(run.verified_at).not.toBeNull();
    // tampering with the backup is detected before restore
    fs.appendFileSync(path.join(dir, 'primary', enc), 'x');
    expect(() => sh('restore-drill.sh')).toThrow();
    // the production DB is untouched by the drill and the throwaway database is gone
    expect((await h.db.one<any>(`SELECT count(*)::int AS n FROM pg_database WHERE datname LIKE 'restore_drill_%'`)).n).toBe(0);
  });
});
