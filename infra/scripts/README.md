# infra/scripts

| Script | Purpose |
|---|---|
| `backup.sh` | Encrypted full PostgreSQL backup (+ second Ethiopian location + optional object mirror), records `backup_runs`, prunes by retention. |
| `restore-drill.sh` | Restores the newest backup into a throw-away database, verifies counts / audit-chain / migrations, stamps `verified_at`, reports restore time against the 2 h RTO. |

Both work against a local Postgres client or a docker container (`PG_CONTAINER=event-platform-postgres-1`). See `docs/DEPLOYMENT.md` §4 for scheduling, WAL archiving and the post-restore deletion re-run.

Example (dev):

```bash
export BACKUP_DIR=$PWD/.tmp-backup/out SECONDARY_DIR=$PWD/.tmp-backup/second \
       BACKUP_PASSPHRASE_FILE=$PWD/.tmp-backup/pass.txt PG_CONTAINER=event-platform-postgres-1 BACKUP_LOCATION_LABEL=addis-dc1-dev
bash infra/scripts/backup.sh && bash infra/scripts/restore-drill.sh
```
