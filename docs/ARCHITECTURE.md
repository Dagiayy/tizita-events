# Architecture

## 1. Topology (all components run on Ethiopia-hosted infrastructure — spec 14.2)

```
 Guest browser/PWA ─┐                    ┌─ Prometheus ─ Grafana
 Flutter Android ───┼─ HTTPS ─ nginx ────┤
 Host / Admin web ──┘  (TLS, limits,     │
                        SSE passthrough) │
                                         ▼
        ┌────────────────────────── API (NestJS, APP_ROLE=api, N replicas) ──────────────────────────┐
        │ Auth/RBAC · Event · Guest · Media(upload gateway, gallery, serve) · Moderation · Payments  │
        │ Exports · Privacy · Admin · Notifications · Audit · Analytics · Realtime (SSE)            │
        └───────┬───────────────┬────────────────────┬──────────────────────┬────────────────────────┘
                │               │                    │                      │
          PostgreSQL        Redis (queues,       MinIO / S3-compatible   ClamAV (clamd)
          (system of        rate limits,         quarantine | media |    (malware scan,
          record + audit)   pub/sub, tickets)    exports  – all private  fail-closed)
                ▲               ▲                    ▲
                └───────────────┴──── Workers (same image, APP_ROLE=worker, scale out) ────────────────┘
                    media-process · export · notify · deletion · maintenance (30 s lifecycle tick,
                    10 min housekeeping, stuck-work sweeper, reconciliation)
 External integrations (explicit, documented in the vendor register): SMS aggregator(s), Chapa / telebirr.
```

Docker Compose profiles: default = Postgres/Redis/MinIO; `app` = api, worker, web, nginx; `av` = ClamAV; `obs` = Prometheus/Grafana. No Kubernetes (spec 14.1).

## 2. Modules (service boundaries — spec 14.4)

| Spec service | NestJS module(s) | Responsibility |
|---|---|---|
| Identity/Auth | `AuthModule` | Phone-OTP, device sessions, rotating refresh + reuse detection, staff TOTP + step-up, global default-deny `AuthGuard`. |
| Event | `EventsModule` | CRUD, **lifecycle state machine** (`lifecycle.ts` + `LifecycleService`), access modes/secrets, sharing (QR PNG/PDF), entitlements, roles (`AccessService`). |
| Guest (part of Event/Gallery) | `GuestModule` | Context, join, phone verification, consent records, signed guest sessions. |
| Media + Gallery | `MediaModule` | Upload gateway (chunked/resumable), async `ProcessingService`, signed serving, gallery read models, realtime fan-out. |
| Moderation | `MediaModule#ModerationService` | State flow, bulk actions, reports, blocking, auto-flag/escalation, logs. |
| Payment | `PaymentsModule` | Orders, provider abstraction (sandbox / Chapa / telebirr-ready), verified settlement, reconciliation, refunds, invoices. |
| Exports | `ExportsModule` | Async ZIP builds, signed time-limited downloads. |
| Privacy | `PrivacyModule` | Rights requests workflow, retention-driven deletion jobs, purge with evidence, legal holds. |
| Notification | `NotificationsService` | `SmsProvider` abstraction (primary + fallback), localized templates, OTP never persisted. |
| Audit | `AuditService` | Append-only hash-chained `audit_events`. |
| Analytics | `AnalyticsService` | Aggregated funnel/KPIs only. |
| Admin/Ops | `AdminModule` | Dashboard, event/org/payment/storage/compliance administration, maintenance workers. |

Cross-cutting (`CoreModule`): typed config with **production safety assertions**, Postgres pool, Redis, S3, BullMQ, Prometheus, idempotency, crypto, request context (AsyncLocalStorage: request id, IP, UA, principal for audit).

## 3. Event lifecycle (spec §7)

`draft → scheduled → live → closing → read_only → archived → deletion_pending → deleted`, plus `suspended` (platform) which remembers the previous state.

* The transition table and the per-state action table are in `events/lifecycle.ts`; **every** route consults them (`assertAllowed(state, action)`), so e.g. guest uploads are only possible in `live`, finishing in-flight uploads in `closing`, gallery viewing in `live/closing/read_only`, exports until the purge deadline.
* All state changes go through `LifecycleService.transition()`: row lock, legality check, side effects (`closed_at`, `retention_until = closed_at + plan retention`, grace deadline + `deletion_jobs` row, `prev_state`), audit event, realtime notification.
* The **scheduler tick** (every 30 s, idempotent, safe on multiple workers): `scheduled→live` at window open; `live→closing` at window end; `closing→read_only` when no media is in `uploaded/processing` (or after `CLOSING_MAX_MINUTES`); `read_only→archived` after `READONLY_TO_ARCHIVE_DAYS`; `read_only|archived→deletion_pending` at `retention_until` (blocked by legal hold); due deletion jobs run; 24 h closing-soon SMS.
* Retention is **configurable policy**, not a constant: plan entitlement (`retention_days`, extendable by add-on) → `system_settings.retention.default_days` → `RETENTION_DEFAULT_DAYS` (180, spec D31, legal validation pending).

## 4. Event access model (spec §7.1, D05, D06)

* Secrets live in `access_secrets`: `upload_token` (`u_…`), `gallery_token` (`g_…`), `join_code` (8 chars, unambiguous alphabet), `passcode` (scrypt). Tokens are looked up by keyed HMAC (`token_hash`); an AES-GCM copy lets *only the owner/moderators* re-display QR/links. Rotation revokes instantly and can strip the scope from already-joined sessions.
* Per scope (`upload`, `gallery`) the host picks `open | code | passcode | verified_phone` (+`view_only` for gallery). `open` requires explicit `privacy_mode=public` (D63). The **locator** (QR link or typed short code) identifies the event; the **credential** satisfies the mode. A join code only ever opens the scopes in `join_code_scope`, so scanning the upload QR never reveals the gallery.
* A guest session is a signed JWT bound to one event **plus** a DB row (`guest_sessions`); scopes, blocking and expiry are re-read from the DB on every request, so revocation is immediate. Devices are tracked by keyed hash for blocking.

## 5. Media pipeline (spec §8)

```
client validate/compress ─▶ POST intent (quota, window, MIME, size) ─▶ chunk PUTs (1 MiB, idempotent, resumable)
   ─▶ complete ─▶ BullMQ 'media-process' ─▶ assemble from QUARANTINE bucket
   ─▶ size check ─▶ magic-byte sniff ─▶ ClamAV (fail-closed) ─▶ decode safety (pixel limit) + HEIC→JPEG (WASM)
   ─▶ metadata (EXIF date/orientation) ─▶ SHA-256 (exact dup → 'duplicate') ─▶ dHash (near-dup flag ≤5 bits)
   ─▶ derivatives thumb/gallery/viewer (all metadata stripped, optional watermark)
   ─▶ [original stored only if plan has original_storage]  ─▶ moderation state (pre: pending | post/trusted: approved)
   ─▶ publish: published_at + SSE (public channel only if approved & folder published) ─▶ quarantine cleanup
```
Retries: BullMQ exponential backoff (5 attempts) for infrastructure errors; deterministic rejections fail permanently with a code. DB-driven sweeper re-queues media stuck in `uploaded/processing` (worker crash), fails them visibly after the retry budget, and cancels abandoned intents (>2 h) — verified by tests. Bucket lifecycle expires leftover quarantine objects after 2 days.

## 6. Authentication & authorization

* **Layers**: (1) `AuthGuard` — principal resolution (user JWT / guest JWT / none), session liveness in DB, role and MFA from DB (token claims are advisory), maintenance mode; (2) `AccessService.requireMember(principal, eventId, permission)` — membership + role matrix (`owner`, `moderator`, `photographer`), 404 for non-members; (3) lifecycle `assertAllowed`; (4) media-state checks in the service (`approved`, folder published, downloads/original rules); (5) at serve time the signed URL is re-validated against *current* state.
* Platform staff are **not** event members. They search metadata only; media access requires a reasoned request approved by a *different* super admin with TOTP, time-boxed (≤2 h), scoped to the event/media, and every listing/view is audited.
* High-risk actions (suspend, refund, legal hold, plan/setting changes, grant approval, erasure jobs, user suspension) require a fresh single-use TOTP in addition to the session's 2FA.

## 7. Payments pipeline (spec §12)

`createOrder` (server price, ETB, idempotent) → provider checkout → customer pays at the licensed gateway → **callback** (signature check, content-hash dedupe) → `settle()`: server-to-server `verifyTransaction` (status + amount + currency) → in one transaction: order `paid`, `entitlements` row (unique per order), invoice (`tax_status='unvalidated'` until accountant sets the VAT rate), event `draft→scheduled/live`, audit, SMS. Anything else (invalid signature, pending/failed/cancelled, amount mismatch, provider outage) grants nothing. Daily/10-minute **reconciliation** recovers missed callbacks and flags paid-but-disputed orders. Refunds are requested via the provider workflow; the system never marks one successful until staff record the provider's confirmation reference. No card/wallet data is stored (asserted by a schema test).

## 8. Notification pipeline (spec §20)

`NotificationsService` → ordered provider chain (`SMS_PROVIDERS=primary,fallback`; `console` for dev, `memory` for tests, generic HTTPS adapter for a local aggregator). OTPs are rendered at send time and **never stored**; transactional messages (payment confirmed, closing soon, deletion scheduled, collaborator invite) are queued through BullMQ with retry and erase the stored phone after delivery. Guests receive no SMS unless the host enables verified-phone access. Push is not used (D43); the Android app uses local notifications.

## 9. Storage layout (never exposed to clients)

`quarantine`: `q/{event}/{media}/part-NNNNN` · `media`: `e/{event}/m/{media}/{thumb|gallery|viewer}.jpg`, `…/original`, `e/{event}/cover/{uuid}.jpg` · `exports`: `x/{event}/{export}.zip`. Event purge deletes the three prefixes and verifies they are empty. Clients only receive HMAC-signed API URLs that map opaque ids to objects after authorization.

## 10. Observability & operations

Prometheus metrics (HTTP latency, queue depth per state, processing backlog/outcomes, payment callback outcomes, events by state, stored bytes), alert rules in `infra/prometheus/alerts.yml`, structured request ids, `GET /health/ready` for orchestration, admin dashboard for backlog/failed processing/SMS usage/incidents. Backup/restore drills: `infra/scripts` (see DEPLOYMENT.md).

## 11. Security summary (spec §17, §18)

TLS + HSTS at the edge; strict CSP/nosniff/frame-deny headers; strict zod schemas; parameterised SQL only; secrets never in code (validated at boot, dev markers rejected in production); AES-256-GCM for phone numbers, TOTP secrets, share tokens; keyed HMAC blind indexes (phone, device, IP); scrypt for passcodes; short-lived access/guest/upload/media/export tokens; refresh rotation; per-IP/per-phone/per-session/per-event rate limits that fail closed; quarantine + magic bytes + ClamAV + pixel limits; per-event quotas and per-session caps; immutable hash-chained audit (DB trigger blocks UPDATE/DELETE, chain verifiable via API); PostgreSQL encryption at rest through encrypted volumes + encrypted dumps; MinIO SSE optional (`S3_SSE`) plus encrypted volumes; Flutter tokens in Android Keystore, Android App Links verified, strict deep-link grammar, cleartext only in debug builds.
