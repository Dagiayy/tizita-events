# Database

PostgreSQL 16, schema managed **only** by forward-only SQL migrations in `apps/api/migrations` (checksummed in `schema_migrations`; editing an applied file aborts the migrator). Run `npm run migrate` (dev) or `node dist/scripts/migrate.js up` (production deploy step). `002_reference_data.sql` seeds plans, platform settings, draft policy texts and the vendor register so a fresh database supports the whole workflow without manual edits.

**Identifier policy**: every primary key is a random UUID (`gen_random_uuid()`); no sequential ids are exposed. Guest-facing locators are separate high-entropy tokens (stored as HMAC); `events.public_code` is an opaque staff-search handle and not a credential. The only sequences are `audit_events.seq` and `invoice_number_seq`.

## Entities and relationships

```
users 1─* sessions                         organizations 1─* users
users 1─* events (owner)  events 1─* event_members (owner|moderator|photographer; invited by phone hash)
events 1─* access_secrets (upload_token|gallery_token|join_code|passcode)
events 1─* event_folders 1─* media         events 1─* guest_sessions ─* media (uploader)
events 1─* media 1─* media_derivatives(thumb|gallery|viewer|original)    media 1─* upload_parts (quarantine chunks)
media 1─* moderation_reports               events 1─* moderation_logs
plans 1─* entitlements *─1 events          events 1─* payment_orders 1─1 invoices   payment_orders 1─* refunds, payment_callbacks
events 1─* exports                         events 1─* analytics_counters / analytics_session_steps
guest_sessions 1─* consent_records         rights_requests ─? events/media/guest_sessions/users   deletion_jobs ─? rights_requests
events 1─* legal_holds                     incidents 1─* incident_log      vendors (standalone register)
media_access_grants (staff elevated access)  support_tickets  notifications  audit_events (append-only)
system_settings  idempotency_keys  otp_challenges  backup_runs  storage_scans  reconciliation_runs  sandbox_transactions (dev)
```

## Tables (purpose · key constraints · retention behaviour)

| Table | Purpose | Notable constraints / indexes | Lifecycle & retention |
|---|---|---|---|
| `users` | Hosts and staff. Phone stored as `phone_hash` (HMAC, unique lookup), `phone_enc` (AES-GCM), `phone_last4`. `platform_role`, TOTP secret (encrypted). | `UNIQUE(phone_hash)`; role index. | Account erasure (rights request) anonymises: phone fields replaced, sessions revoked; refuses while the user owns live events. |
| `sessions` | Host/staff device sessions; `refresh_hash` + `prev_refresh_hash` (reuse detection), MFA flags. | `UNIQUE(refresh_hash)`; partial index on active sessions. | Revoked on logout/recovery/suspension; expired rows are inert. |
| `otp_challenges` | Hashed OTP codes (host + guest verification), attempts, expiry. | Index `(phone_hash, purpose, created_at)`. | Short-lived; consumed on use. |
| `organizations` | Business accounts (TIN optional, verification state). | | Kept (billing relationship). |
| `plans` | Catalogue in ETB (`currency CHECK ('ETB')`): storage, media cap, retention days, original storage, seats, concurrency, watermark/branding, `is_trial`, `kind package|addon`. | `UNIQUE(code)`. | Edits do not affect existing entitlements (snapshotted). |
| `entitlements` | Per-event grant snapshot from payment / free trial / staff grant. Effective limits = latest package + sum of add-ons. | `UNIQUE(order_id)` ⇒ a payment can never grant twice. | Revoked on full refund; kept after event deletion (financial record). |
| `events` | Event, settings, lifecycle timestamps, counters. `CHECK (country='ET')`, window checks, state enum (9 states), `legal_hold`. | Indexes for scheduler scans: `(upload_opens_at) WHERE scheduled`, `(upload_closes_at) WHERE live`, `(retention_until) WHERE read_only|archived`, `(deletion_deadline) WHERE deletion_pending`. | On purge: name/venue/host/cover scrubbed, counters zeroed, state `deleted`; the tombstone row stays (payments/audit reference it). |
| `event_members` | Role per user; pending invitations by phone hash (`status invited → active`). | Partial unique indexes per user / pending invite. | Removed on purge. |
| `event_folders` | Pre-event / Ceremony / Reception / Highlights / custom; `publication_state draft|published`, per-folder download/watermark flags. | | Removed on purge. |
| `access_secrets` | Hashed event locators/credentials (see ARCHITECTURE §4). | Unique active `token_hash`; one active secret per type per event. | Revoked on rotation; deleted on purge. |
| `guest_sessions` | Anonymous (or phone-verified) sessions: scopes, hashed device/IP, block state, upload count, expiry. | Index `(event_id, device_hash)`. | Deleted on purge / erasure request. |
| `blocked_devices` | Device hashes blocked per event. | PK `(event_id, device_hash)`. | Purged with event. |
| `media` | Upload + moderation state machine, hashes (`sha256`, `phash` bigint), dimensions, capture time, quota bytes, failure codes, timestamps, `quarantine_prefix` (internal). | **Gallery keyset index** `(event_id, published_at DESC, id DESC) WHERE ready AND approved`; unique `(event_id, sha256)` for ready media (exact-dup guard); partial indexes for stuck-processing and stale intents. | `deleted_at` + objects removed on moderation delete/guest delete; all rows removed on event purge. |
| `media_derivatives` | Object keys, size, checksum per variant (keys internal). | `UNIQUE(media_id, variant)`. | Deleted with media. |
| `upload_parts` | Chunk bookkeeping for resumable upload. | PK `(media_id, part_no)`. | Removed after processing/cancel. |
| `moderation_reports` | Reports with reason, severity, status (`open|actioned|dismissed|escalated`). | One open report per `(media, session)`. | Removed with media. |
| `moderation_logs` | Host/system/staff moderation actions with before/after state and reason. | | Purged with event. |
| `payment_orders` | Server-priced order, provider reference, verified state machine incl. `mismatch`, `refund_*`. | `UNIQUE(order_ref)`, idempotency key per user, unique `(provider, provider_reference)`. | **Retained** after event deletion (legal/financial record); no credentials stored. |
| `payment_callbacks` | Every callback (valid or not) with redacted payload and outcome; content-hash dedupe. | `UNIQUE(dedupe_key)`. | Retained for reconciliation/audit. |
| `refunds`, `invoices`, `reconciliation_runs` | Refund workflow, invoice numbers (`INV-YYYY-nnnnnn`, tax status), daily reconciliation reports. | `UNIQUE(order_id)` on invoices. | Retained. |
| `notifications` | SMS/in-app records. OTP text never stored; stored phone erased after delivery. | | Params scrubbed on event purge. |
| `audit_events` | Append-only, hash-chained (`prev_hash`, `hash`), actor/role, resource, reason, before/after summary, IP, device, request id. | Trigger rejects `UPDATE/DELETE`; indexes by actor, resource, event, action. | **Never deleted** by the application (retention period is a legal decision — see LEGAL_FLAGS). Summaries contain identifiers/state only. |
| `media_access_grants` | Staff elevated-access requests: reason, ticket, approver, expiry. | `reason` ≥ 10 chars. | Retained as evidence. |
| `consent_records` | Purpose, policy version, locale, granted/withdrawn, session/user/event. | | **Retained** after purge (evidence); session link set to NULL on session deletion. |
| `policy_documents` | Versioned notices (EN/AM) with `legal_status`. | `UNIQUE(kind, version, locale)`. | Versioned, never edited. |
| `rights_requests` | Intake → identity verification → in progress → completed/rejected, due date, evidence timeline, hashed access token. | | Retained as evidence. |
| `deletion_jobs` | Event/media/guest-session/user erasure with trigger, schedule, status (`pending|running|completed|failed|cancelled|held`), `legal_hold`, evidence JSON (counts only), `backup_purge_by`. | Unique active job per resource. | Retained as completion evidence. |
| `legal_holds` | Hold history (placed/released by). | | Retained. |
| `incidents`, `incident_log` | Breach/security incidents; `discovered_at` starts the 72 h clock (`regulator_notify_due_at`). | | Retained. |
| `vendors` | Processor register: data categories, location, `outside_ethiopia`, DPA, transfer assessment. | A vendor outside Ethiopia cannot be `active` without DPA + assessment (enforced in code). | Retained. |
| `exports` | Async ZIP jobs. | | Objects deleted after 7 days (`expired`); rows purged with event. |
| `analytics_counters`, `analytics_session_steps` | Per-event/day funnel counters; first occurrence of a step per session (unique viewers) — no payloads, no identity. | | Deleted with event. |
| `idempotency_keys`, `system_settings`, `storage_scans`, `backup_runs` | Operational. | | Keys purged after 48 h; backup rows record encryption, location label, verification time. |

## Retention & deletion behaviour (configurable; defaults flagged for counsel)

1. Closure sets `closed_at` and `retention_until = closed_at + entitlement.retention_days` (add-ons extend and recalculate). Default policy value 180 days (D31).
2. After `READONLY_TO_ARCHIVE_DAYS` the event auto-archives; at `retention_until` it enters `deletion_pending` (unless `legal_hold`) with a grace period of 7–30 days (default 14, D32) and a `deletion_jobs` row. The host can cancel until the deadline.
3. The job deletes objects (media/quarantine/exports prefixes, verified empty), DB rows (media, guest sessions, secrets, folders, members, analytics, exports, moderation logs), scrubs the event, records evidence and an audit event. **Retained**: payments, invoices, entitlements, consent records, rights requests, audit events, deletion jobs.
4. Backups are not rewritten: they expire after `BACKUP_RETENTION_DAYS` (default 35, D33); each job records `backup_purge_by`. Restoring a backup requires re-running pending deletions (documented in DEPLOYMENT.md).
5. Legal hold parks jobs (`held`) and blocks retention-driven and host-requested deletion until released (both audited).
