# Deployment and operations

> Production **must** run on Ethiopia-hosted compute, database, object storage and backups (PDPP Art. 22, spec 14.2). The API refuses to boot in production if `DATABASE_URL`, `REDIS_URL` or `S3_ENDPOINT` point at a foreign cloud or at a host outside `DATA_RESIDENCY_ALLOWED_HOST_SUFFIXES`, if any secret still contains a development marker, if `OTP_FIXED_CODE` is set, if the AV mode is not `clamd`, if `PAYMENT_PROVIDER=sandbox`, or if the first SMS provider is `console`/`memory`.

## 1. Local development

Prerequisites: Node 20+, Docker, Flutter 3.44+ (Android toolchain) for the app.

```bash
cp .env.example .env                       # dev defaults are safe for localhost only
docker compose -f infra/docker-compose.yml --env-file .env up -d        # Postgres :5433, Redis :6380, MinIO :9100 (+console :9101)

cd apps/api && npm install
npm run migrate                            # applies migrations/*.sql (also auto-run by `npm run start:dev` outside production)
npm run seed                               # dev staff accounts +251911000001 (super_admin) / +251911000002 (support)
# local-only conveniences in .env:  OTP_FIXED_CODE=123456   SMS_PROVIDERS=console   PAYMENT_PROVIDER=sandbox
npm run start:dev                          # API + in-process workers (APP_ROLE=all) on :4000

cd ../web && npm install && npm run dev    # http://localhost:3000   (proxies /v1/* to the API; use -p 3100 if 3000 is taken)
cd ../mobile && flutter pub get && flutter run --dart-define=API_BASE=http://10.0.2.2:4000 --dart-define=WEB_HOST=localhost
```

Sign-in is by SMS code: with `SMS_PROVIDERS=console` the code is printed in the API log; with `OTP_FIXED_CODE` it is fixed (never allowed in production). Sandbox payments: after creating an order the web console redirects to `/pay/sandbox` where you can simulate success/failure.

First staff account (any environment): `npm run admin:bootstrap -- +251911000001 super_admin`, sign in at `/admin`, enrol an authenticator app on the 2FA screen (mandatory).

## 2. Configuration

All settings are environment variables — see [`.env.example`](../.env.example) (every key documented, no real secrets). Highlights:

| Group | Keys | Notes |
|---|---|---|
| Secrets (production: from the Ethiopia-hosted secret store) | `JWT_ACCESS_SECRET`, `JWT_GUEST_SECRET`, `URL_SIGNING_SECRET`, `HASH_PEPPER`, `DATA_ENCRYPTION_KEY` (32-byte base64), `METRICS_TOKEN`, `S3_*`, `CHAPA_*`, `SMS_HTTP_*` | Generate with `openssl rand -base64 48`. **Rotating `HASH_PEPPER` or `DATA_ENCRYPTION_KEY` invalidates phone blind indexes / encrypted data — plan a re-encryption migration before rotating.** |
| Roles | `APP_ROLE=api|worker|all` | Run N× `api` and M× `worker` containers (`docker compose up -d --scale worker=3`). |
| Policy | `RETENTION_DEFAULT_DAYS`, `READONLY_TO_ARCHIVE_DAYS`, `DELETION_GRACE_DAYS`, `BACKUP_RETENTION_DAYS`, `MEDIA_*`, `DERIV_*`, rate limits | Also editable at runtime in Admin → Configuration (`system_settings`, audited, 2FA). |
| Feature flags | `FEATURE_COMMENTS`, `FEATURE_REACTIONS`, `FEATURE_VIDEO`, `FEATURE_GEO_RESTRICTION` | Deferred features stay **off**. |

### Full stack in Docker (one container per service)

| Container | Profile | Purpose |
|---|---|---|
| `postgres`, `redis`, `minio`, `minio-init` | default | data plane; `minio-init` creates the 3 private buckets once |
| `migrate` | app | one-shot schema migration; `api`/`worker` start only after it succeeds |
| `api`, `worker` | app | same image (`event-platform-api`), role chosen by `APP_ROLE`; scale with `--scale worker=3` |
| `web` | app | Next.js standalone (CSP `'self'` only; nginx serves web + API from one origin) |
| `nginx` | app | TLS edge, rate limits, SSE routing, `/metrics` allow-list |
| `clamav` | av | real antivirus (required in production) |
| `prometheus`, `grafana` | obs | metrics token injected from `.env` at start |
| `backup` | ops | daily AES-256 encrypted `pg_dump` into the `backups` volume (mirror it to the second Ethiopian site) |
| `mobile-build` | mobile | one-shot Flutter APK build -> `dist/mobile/` |

Data ports are bound to `127.0.0.1`; containers run with all capabilities dropped and `no-new-privileges`.

**Local (HTTP, sandbox payments, fixed OTP — development only):**
```bash
docker compose -f infra/docker-compose.yml -f infra/docker-compose.local.yml --env-file .env --profile app up -d --build
# app + API on http://localhost:8080 ; check: curl http://localhost:8080/health/ready
```
**Production-style (verified with real ClamAV, https, safety checks on):**
```bash
./infra/scripts/gen-secrets.sh > .env          # fresh random secrets from .env.docker.example; then set domain, SMS and payment values
./infra/scripts/gen-dev-certs.sh your.domain   # staging only; production: real certificate -> infra/nginx/certs/{fullchain,privkey}.pem
docker compose --profile app --profile av --profile ops --profile obs up -d --build   # root compose.yaml includes infra/docker-compose.yml
docker compose run --rm api node dist/scripts/bootstrap-admin.js +2519XXXXXXXX super_admin
```
`ENV_FILE=path` selects a different env file for api/worker/migrate. Compose service names (`postgres`, `redis`, `minio`, `clamav`) are listed in `DATA_RESIDENCY_ALLOWED_HOST_SUFFIXES` in the template; remove them if you point at external Ethiopian hosts and list those instead.
**Android APK:** `docker compose --profile mobile run --rm mobile-build` (set `PUBLIC_API_URL` / `MOBILE_WEB_HOST`; release signing needs `android/key.properties`).

## 3. Production deployment (Docker Compose on Ethiopian infrastructure)

1. Provision the hosts (spec 14.2 options): primary site + secondary site in Ethiopia, encrypted volumes, private network between services. Contract/SLA, object-store capability, backup location and support must be verified before selection (decision D69).
2. Create `.env` from the secret store (never commit). Set `NODE_ENV=production`, `PUBLIC_*_URL=https://…`, `TRUST_PROXY=true`, `DATABASE_SSL=true` if the DB is remote, `AV_MODE=clamd`, a real `SMS_PROVIDERS` chain, `PAYMENT_PROVIDER=chapa|telebirr`, `CORS_ORIGINS`, `DATA_RESIDENCY_ALLOWED_HOST_SUFFIXES`.
3. Place TLS material in `infra/nginx/certs` (`fullchain.pem`, `privkey.pem`) and review `infra/nginx/nginx.conf` (limits, IP allow-list for `/metrics`).
4. Build and start: `docker compose -f infra/docker-compose.yml --env-file .env --profile app --profile av up -d --build`.
5. Migrate (deployment step, **not** at boot in production): `docker compose run --rm api node dist/scripts/migrate.js up`.
   **Least privilege (spec 18)**: run `infra/postgres/roles.sql` once so the migrator, API, workers and read-only tooling use separate database roles (the app roles cannot alter the schema or touch `audit_events` beyond INSERT/SELECT), and create per-service MinIO accounts from `infra/minio/policies` (see `infra/minio/README.md`). Give the API and workers different credentials.
6. Create buckets/lifecycle (the `minio-init` job does this: three private buckets, quarantine expires after 2 days, exports after 3) and, for production MinIO, enable server-side encryption (KES or `S3_SSE`) plus encrypted volumes.
7. Verify: `GET /health/ready` (database, redis, storage, antivirus), `GET /metrics` with the token, create a trial event and run a smoke upload.

### Workers, queues, scaling
* Queues (BullMQ on Redis, AOF + `noeviction`): `media-process` (concurrency 3/worker), `export` (1), `notify` (5), `deletion` (1), `maintenance` (30 s tick + 10 min heavy). Scale workers horizontally; the tick and deletion runs are idempotent.
* Backlog is visible in Prometheus (`queue_jobs{queue,state}`, `media_processing_backlog`), alert rules `MediaProcessingBacklog`, `MediaProcessingStuck`, `ExportBacklog`, and in Admin → Dashboard.
* Burst after a QR scan: uploads go chunk-by-chunk through the API to quarantine, processing is asynchronous, publish fan-out is Redis pub/sub. nginx limits are tuned for venue Wi-Fi NAT (many phones behind one IP).

### SMS (spec 3.3, 9.4)
Implement/choose a local aggregator (Ethio telecom + Safaricom Ethiopia routes) with a primary and a fallback: set `SMS_PROVIDERS=primary,fallback` and `SMS_HTTP_PRIMARY_URL|API_KEY|SENDER_ID` (+ `FALLBACK`). The adapter posts `{to, from, message}` JSON with a bearer key and expects `{id}`; adapt `HttpSmsProvider` in `notifications.service.ts` to your aggregator's contract. Register each provider in the vendor register (Admin → Compliance → Vendors) before go-live. Monitor delivery in Admin → Dashboard → SMS usage; templates are localized (en/am) in `notifications.service.ts`.

### Payments (spec 12)
* **Chapa**: set `CHAPA_SECRET_KEY`, `CHAPA_WEBHOOK_SECRET`, `PAYMENT_PROVIDER=chapa`, `PAYMENT_CALLBACK_BASE_URL=https://api…`. Configure the webhook to `POST /v1/payments/callbacks/chapa` (signature header `x-chapa-signature`). Run Admin → Payments → Run reconciliation daily (also automatic).
* **Direct telebirr**: `TelebirrProvider` is a design-ready placeholder (decision D23); implement `createCheckout/verifyTransaction/parseCallback/verifyCallbackSignature` after onboarding and set `PAYMENT_PROVIDER=telebirr`. Nothing else changes.
* Refunds: Admin → Payments → Refund creates a *processing* refund; after the provider completes it, record the provider reference with **Confirm** (never faked).
* **Before charging customers**: have the accountant confirm VAT/TOT, e-invoicing and cash-register obligations, then set `tax.vat_rate` (Admin → Configuration); invoices show `tax_status` accordingly.

### Android app (App Links)
Build with `--dart-define=API_BASE=https://api.example.et --dart-define=WEB_HOST=photos.example.et`. Replace `photos.example.et` in `AndroidManifest.xml`, publish `https://photos.example.et/.well-known/assetlinks.json` (package `et.eventphotos.event_photos` + signing certificate SHA-256) so QR/links open the installed app or the browser. Configure release signing via `key.properties` (never commit).

## 4. Backups and restoration (spec 18, 24; RPO ≤ 15 min / RTO ≤ 2 h targets)

| Layer | Mechanism |
|---|---|
| PostgreSQL full | `infra/scripts/backup.sh` — `pg_dump -Fc` → AES-256 (OpenSSL PBKDF2) → `BACKUP_DIR` + `SECONDARY_DIR` (second Ethiopian site) + SHA-256; records `backup_runs`; prunes after `BACKUP_RETENTION_DAYS`. Schedule daily (cron/systemd timer). |
| PostgreSQL continuous (RPO ≤ 15 min) | Enable WAL archiving (`archive_mode=on`, `archive_command` to an encrypted store in Ethiopia, e.g. pgBackRest/WAL-G with repository encryption) or a streaming replica at the second site; configure retention ≤ `BACKUP_RETENTION_DAYS`. The compose file is the single-site MVP topology. |
| Object storage | `mc mirror` of `event-media` to a second MinIO/site (`MC_BACKUP_ALIAS`), versioning + replication in production; exports are rebuildable and not backed up. |
| Verification | `infra/scripts/restore-drill.sh` restores the newest dump into a throw-away database, checks row counts, audit-chain continuity and migrations, stamps `backup_runs.verified_at` and prints the measured restore time vs the 2 h RTO. Run it at least weekly (also exercised by `test/e2e/backup-restore.spec.ts`). |

Disaster recovery: restore the database from the latest verified dump (+ WAL replay), restore `event-media`, run `node dist/scripts/migrate.js up`, start API/workers, then **re-run deletions that completed after the backup**: query `deletion_jobs WHERE completed_at > <backup time>` and execute them again (the Admin → Compliance → Deletion jobs → *Run now*) so erased media does not reappear (risk R9).

## 5. Monitoring
`docker compose … --profile obs up -d`: Prometheus (`:9090`, scrape config needs the metrics token), Grafana (`:3001`). Alert rules: backlog, stalled processing, failed jobs, payment outage / forged signatures, 5xx rate, p95 latency. Ship container/nginx JSON logs to a **local** log stack (Loki/ELK in Ethiopia). Pen-test before public launch and after major auth/storage changes (spec 18).

## 6. Operational runbooks (short)
* **Queue backlog**: check `queue_jobs`, add `worker` replicas, check ClamAV and Redis health; stuck media self-heals within ~3 minutes via the sweeper.
* **Provider outage (payments)**: orders fail safely with "not charged"; callbacks answer 503 and are re-processed on redelivery; reconciliation recovers the rest.
* **Abuse spike**: Admin → Moderation → signals; suspend the event (2FA), block sessions/devices, lower `guest.max_uploads_per_session`, enable maintenance mode if needed.
* **Breach**: Admin → Compliance → Incidents → record the *discovery time* (starts the 72 h regulator/data-subject clocks), rotate secrets, revoke sessions, follow the playbook (legal doc, LEGAL_FLAGS).
* **Staff media access request**: support requests with reason/ticket → a different super admin approves with TOTP (max 2 h) → access and views are audited; revoke at any time.
