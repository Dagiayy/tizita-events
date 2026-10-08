#!/usr/bin/env bash
# Generates a production .env from .env.docker.example with fresh random secrets.
#   ./infra/scripts/gen-secrets.sh > .env      (then edit domain names, SMS and payment provider values)
# Never commit the output. Rotating HASH_PEPPER / DATA_ENCRYPTION_KEY later invalidates existing data - see docs/DEPLOYMENT.md.
set -euo pipefail
cd "$(dirname "$0")/../.."
r() { openssl rand -base64 "${1:-48}" | tr -d '\n=+/' | cut -c1-"${2:-48}"; }
sed \
  -e "s|@JWT_ACCESS_SECRET@|$(r 48 56)|" -e "s|@JWT_GUEST_SECRET@|$(r 48 56)|" \
  -e "s|@URL_SIGNING_SECRET@|$(r 48 56)|" -e "s|@HASH_PEPPER@|$(r 48 56)|" \
  -e "s|@METRICS_TOKEN@|$(r 48 48)|" -e "s|@DATA_ENCRYPTION_KEY@|$(openssl rand -base64 32 | tr -d '\n')|" \
  -e "s|@POSTGRES_PASSWORD@|$(r 36 32)|" -e "s|@MINIO_ROOT_PASSWORD@|$(r 48 40)|" \
  -e "s|@MINIO_ROOT_USER@|minio_$(r 12 12)|" -e "s|@GRAFANA_ADMIN_PASSWORD@|$(r 24 24)|" \
  -e "s|@BACKUP_PASSPHRASE@|$(r 48 48)|" \
  .env.docker.example
