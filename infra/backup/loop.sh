#!/usr/bin/env bash
# Runs backup.sh every BACKUP_INTERVAL_HOURS (default 24), first run after BACKUP_FIRST_DELAY_SEC (default 60).
set -u
: "${BACKUP_PASSPHRASE:?BACKUP_PASSPHRASE is required}"
umask 077
export BACKUP_PASSPHRASE_FILE=/tmp/backup.pass BACKUP_DIR="${BACKUP_DIR:-/backups}"
printf '%s' "$BACKUP_PASSPHRASE" > "$BACKUP_PASSPHRASE_FILE"
unset BACKUP_PASSPHRASE
sleep "${BACKUP_FIRST_DELAY_SEC:-60}"
while true; do
  /usr/local/bin/backup.sh || echo "backup FAILED at $(date -u +%FT%TZ)" >&2
  sleep "$(( ${BACKUP_INTERVAL_HOURS:-24} * 3600 ))"
done
