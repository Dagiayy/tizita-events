import { loadConfig } from '../src/common/config';
import { migrationStatus, runMigrations } from '../src/infra/migrate';

async function main() {
  const cfg = loadConfig();
  const cmd = process.argv[2] ?? 'up';
  if (cmd === 'status') {
    for (const m of await migrationStatus(cfg.DATABASE_URL)) console.log(`${m.applied ? '[x]' : '[ ]'} ${m.name}`);
    return;
  }
  const applied = await runMigrations(cfg.DATABASE_URL);
  console.log(applied.length ? `Applied ${applied.length} migration(s).` : 'Database is up to date.');
}
main().catch((e) => { console.error(e.message); process.exit(1); });
