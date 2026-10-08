#!/usr/bin/env bash
# Self-signed TLS certificate for staging/testing the production nginx config. Production: use a real certificate
# issued for your Ethiopia-hosted domain and place fullchain.pem / privkey.pem in infra/nginx/certs.
set -euo pipefail
cd "$(dirname "$0")/../nginx"
mkdir -p certs
HOST="${1:-localhost}"
MSYS_NO_PATHCONV=1 openssl req -x509 -newkey rsa:2048 -nodes -days 90 -keyout certs/privkey.pem -out certs/fullchain.pem \
  -subj "/CN=$HOST" -addext "subjectAltName=DNS:$HOST,DNS:localhost,IP:127.0.0.1"
echo "wrote infra/nginx/certs/{fullchain,privkey}.pem for $HOST (self-signed, 90 days)"
