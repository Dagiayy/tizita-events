#!/usr/bin/env bash
# Encrypted backup of PostgreSQL (+ object storage mirror) to an Ethiopia-hosted target (spec 18, 24 "DR").
#   RPO <= 15 min in production needs continuous WAL archiving (see docs/DEPLOYMENT.md "Backups"); this script is the
#   daily FULL backup + object mirror + retention pruning, and it records every run in backup_runs.
#
# Required env (from the Ethiopia-hosted secret store):
#   BACKUP_DIR            local path on the primary Ethiopian site          (e.g. /srv/backups)
#   BACKUP_PASSPHRASE_FILE  file containing the encryption passphrase       (mode 0400)
#   BACKUP_LOCATION_LABEL   human label of the Ethiopian site, e.g. "addis-dc1"
# Optional:
#   PG_CONTAINER          run pg tools inside this docker container (dev/compose)  else local pg_dump / psql are used
#   DATABASE_URL          used when PG_CONTAINER is not set
#   PGUSER/PGDATABASE     defaults for PG_CONTAINER mode (event/event)
#   SECONDARY_DIR         second Ethiopian location (rsync target or mounted path) - recommended
#   BACKUP_RETENTION_DAYS default 35: expired backups are deleted so erased media does not persist forever (D33)
set -euo pipefail

: "${BACKUP_DIR:?BACKUP_DIR is required}"
: "${BACKUP_PASSPHRASE_FILE:?BACKUP_PASSPHRASE_FILE is required}"
# native openssl on Windows (Git Bash) needs a Windows-style path
PASSFILE="$BACKUP_PASSPHRASE_FILE"; if command -v cygpath >/dev/null 2>&1; then PASSFILE="$(cygpath -m "$BACKUP_PASSPHRASE_FILE")"; fi

LABEL="${BACKUP_LOCATION_LABEL:-unlabeled-site}"
RETENTION="${BACKUP_RETENTION_DAYS:-35}"
PGUSER="${PGUSER:-event}"; PGDATABASE="${PGDATABASE:-event}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$BACKUP_DIR"
OUT="$BACKUP_DIR/db-$STAMP.dump.enc"

psql_q() { if [ -n "${PG_CONTAINER:-}" ]; then docker exec -i "$PG_CONTAINER" psql -U "$PGUSER" -d "$PGDATABASE" -Atq -v ON_ERROR_STOP=1 -c "$1"; else psql "$DATABASE_URL" -Atq -v ON_ERROR_STOP=1 -c "$1"; fi; }
dump()   { if [ -n "${PG_CONTAINER:-}" ]; then docker exec "$PG_CONTAINER" pg_dump -U "$PGUSER" -d "$PGDATABASE" -Fc --no-owner; else pg_dump "$DATABASE_URL" -Fc --no-owner; fi; }

RUN_ID="$(psql_q "INSERT INTO backup_runs (kind, status, location_label, encrypted, expires_at) VALUES ('database','running','$LABEL',true, now() + interval '$RETENTION days') RETURNING id")"
trap 'psql_q "UPDATE backup_runs SET status='"'"'failed'"'"', finished_at=now() WHERE id='"'"'$RUN_ID'"'"' AND status='"'"'running'"'"'" >/dev/null || true' ERR

# 1) dump -> AES-256 encrypt (PBKDF2) -> file. Plain dumps never touch disk.
dump | openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -pass "file:$PASSFILE" > "$OUT"
BYTES="$(wc -c < "$OUT" | tr -d ' ')"
sha256sum "$OUT" > "$OUT.sha256"

# 2) second Ethiopian location
if [ -n "${SECONDARY_DIR:-}" ]; then mkdir -p "$SECONDARY_DIR" && cp "$OUT" "$OUT.sha256" "$SECONDARY_DIR/"; fi

# 3) object storage mirror (media + exports are rebuildable only from here) - requires `mc` configured with aliases `primary` and `backup`
if command -v mc >/dev/null 2>&1 && [ -n "${MC_BACKUP_ALIAS:-}" ]; then
  mc mirror --overwrite --remove "${MC_PRIMARY_ALIAS:-primary}/event-media" "$MC_BACKUP_ALIAS/event-media" >/dev/null
  psql_q "INSERT INTO backup_runs (kind, status, location_label, encrypted, started_at, finished_at, expires_at) VALUES ('objects','succeeded','$LABEL',true, now(), now(), now() + interval '$RETENTION days')" >/dev/null
fi

# 4) retention: prune expired files (also on the secondary)
find "$BACKUP_DIR" -name 'db-*.dump.enc*' -mtime +"$RETENTION" -delete
[ -n "${SECONDARY_DIR:-}" ] && find "$SECONDARY_DIR" -name 'db-*.dump.enc*' -mtime +"$RETENTION" -delete || true

psql_q "UPDATE backup_runs SET status='succeeded', bytes=$BYTES, finished_at=now(), note='$(basename "$OUT")' WHERE id='$RUN_ID'" >/dev/null
echo "backup ok: $OUT ($BYTES bytes) run=$RUN_ID"
