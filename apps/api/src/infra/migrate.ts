import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { Client } from 'pg';

/** migrations/ sits two levels up from src/infra (ts-node) or three from dist/src/infra (compiled image). */
function defaultDir(): string {
  for (const rel of ['../../migrations', '../../../migrations']) {
    const d = path.resolve(__dirname, rel);
    if (fs.existsSync(d)) return d;
  }
  throw new Error('migrations directory not found');
}

/**
 * Forward-only SQL migrations (production schema is never created by hand).
 * Each file runs in its own transaction; applied files are checksummed so edits to history are detected.
 */
export async function runMigrations(databaseUrl: string, dir = defaultDir(), log: (m: string) => void = console.log): Promise<string[]> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  const applied: string[] = [];
  try {
    await client.query('SELECT pg_advisory_lock(7001002)');
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
    const done = new Map((await client.query<{ name: string; checksum: string }>('SELECT name, checksum FROM schema_migrations')).rows.map((r) => [r.name, r.checksum]));
    const files = fs.readdirSync(dir).filter((f) => /^\d+_.+\.sql$/.test(f)).sort();
    for (const f of files) {
      const sql = fs.readFileSync(path.join(dir, f), 'utf8');
      const sum = createHash('sha256').update(sql).digest('hex');
      if (done.has(f)) {
        if (done.get(f) !== sum) throw new Error(`Migration ${f} was modified after being applied`);
        continue;
      }
      log(`applying ${f}`);
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1,$2)', [f, sum]);
        await client.query('COMMIT');
        applied.push(f);
      } catch (e) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${f} failed: ${(e as Error).message}`);
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock(7001002)').catch(() => undefined);
    await client.end();
  }
  return applied;
}

export async function migrationStatus(databaseUrl: string, dir = defaultDir()) {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const exists = await client.query(`SELECT to_regclass('schema_migrations') AS t`);
    const done = exists.rows[0].t ? new Set((await client.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((r) => r.name)) : new Set<string>();
    return fs.readdirSync(dir).filter((f) => /^\d+_.+\.sql$/.test(f)).sort().map((f) => ({ name: f, applied: done.has(f) }));
  } finally { await client.end(); }
}
