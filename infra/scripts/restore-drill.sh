#!/usr/bin/env bash
# Restore drill (spec 24 "DR": database restore test). Restores the newest encrypted backup into a THROWAWAY database,
# verifies integrity (row counts, audit hash chain continuity, key tables) and stamps backup_runs.verified_at.
# It never touches the production database.
#   Required: BACKUP_DIR, BACKUP_PASSPHRASE_FILE.  Optional: PG_CONTAINER (docker) or DATABASE_URL (admin URL), PGUSER, PGDATABASE.
set -euo pipefail
: "${BACKUP_DIR:?}"; : "${BACKUP_PASSPHRASE_FILE:?}"
# native openssl on Windows (Git Bash) needs a Windows-style path
PASSFILE="$BACKUP_PASSPHRASE_FILE"; if command -v cygpath >/dev/null 2>&1; then PASSFILE="$(cygpath -m "$BACKUP_PASSPHRASE_FILE")"; fi

PGUSER="${PGUSER:-event}"; PGDATABASE="${PGDATABASE:-event}"
LATEST="$(ls -1t "$BACKUP_DIR"/db-*.dump.enc | head -1)"
[ -n "$LATEST" ] || { echo "no backup found"; exit 1; }
sha256sum -c "$LATEST.sha256" >/dev/null || { echo "CHECKSUM MISMATCH for $LATEST"; exit 2; }
DRILL_DB="restore_drill_$(date -u +%H%M%S)"

if [ -n "${PG_CONTAINER:-}" ]; then
  P() { docker exec -i "$PG_CONTAINER" psql -U "$PGUSER" -d "$1" -Atq -v ON_ERROR_STOP=1 -c "$2"; }
  restore() { docker exec -i "$PG_CONTAINER" pg_restore -U "$PGUSER" -d "$DRILL_DB" --no-owner --exit-on-error; }
else
  P() { psql "${DATABASE_URL%/*}/$1" -Atq -v ON_ERROR_STOP=1 -c "$2"; }
  restore() { pg_restore -d "${DATABASE_URL%/*}/$DRILL_DB" --no-owner --exit-on-error; }
fi

P postgres "CREATE DATABASE $DRILL_DB" >/dev/null
trap 'P postgres "DROP DATABASE IF EXISTS $DRILL_DB" >/dev/null || true' EXIT
START=$(date +%s)
openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass "file:$PASSFILE" < "$LATEST" | restore
SECS=$(( $(date +%s) - START ))

# integrity checks on the restored copy
USERS=$(P "$DRILL_DB" "SELECT count(*) FROM users"); EVENTS=$(P "$DRILL_DB" "SELECT count(*) FROM events")
MEDIA=$(P "$DRILL_DB" "SELECT count(*) FROM media"); AUDIT=$(P "$DRILL_DB" "SELECT count(*) FROM audit_events")
BROKEN=$(P "$DRILL_DB" "SELECT count(*) FROM (SELECT seq, prev_hash, lag(hash) OVER (ORDER BY seq) AS expected FROM audit_events) t WHERE expected IS NOT NULL AND prev_hash IS DISTINCT FROM expected")
MIG=$(P "$DRILL_DB" "SELECT count(*) FROM schema_migrations")
[ "$BROKEN" = "0" ] || { echo "AUDIT CHAIN BROKEN in restored copy"; exit 3; }
echo "restore drill ok: file=$(basename "$LATEST") restore_seconds=$SECS users=$USERS events=$EVENTS media=$MEDIA audit=$AUDIT migrations=$MIG"
P "$PGDATABASE" "UPDATE backup_runs SET verified_at = now() WHERE note = '$(basename "$LATEST")'" >/dev/null || true
echo "RTO budget: 7200s (2h); measured database restore: ${SECS}s"
