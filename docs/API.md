# API reference

Base path `/v1`. JSON in/out (`Content-Type: application/json`) except chunk uploads (`application/octet-stream`), cover images (`image/*`) and the binary QR/ZIP/media downloads. The complete, always-current route list (146 routes with their authentication policy) is generated from the code in [`API_ROUTES.md`](API_ROUTES.md); this file documents behaviour, contracts and error semantics.

## Conventions

**Authentication principals**

| Principal | Credential | Lifetime | Notes |
|---|---|---|---|
| Host / collaborator / staff | `Authorization: Bearer <access JWT>` | 15 min | Refresh token rotates on every use (30 d); web gets it as an HttpOnly cookie (`X-Client-Kind: web`), mobile/API clients in the JSON body. Re-use of an old refresh token revokes the whole session. |
| Staff | Access token with `mfa=true` | per session | OTP + authenticator-app TOTP. `mfa_required` (403) until verified. High-risk actions need a fresh `totp_code` (single-use per 30 s step). |
| Guest | `Authorization: Bearer <guest JWT>` | 12 h (renewable via `/guest/refresh`, absolute 7 d) | Bound to one event; scopes `upload` / `gallery` are read from the database on every request, so blocking/revoking is immediate. |
| Upload gateway | `X-Upload-Token: <token>` | 1 h | Per-media HMAC token returned by an upload intent. |
| Provider callbacks | provider signature header | — | Authenticity only; activation requires server-to-server verification. |

**Authorization** is enforced server-side on every route: principal → role → event membership → event lifecycle state → media state → action. Non-members receive **404** (never 403) for events they cannot access so identifiers cannot be probed. Every route must declare an `@Auth(...)` policy; routes without one are rejected (default deny, asserted by a test).

**Errors** — always `{"error": {"code": "snake_case", "message": "…", "request_id": "…", "details"?: …}}` with `X-Request-Id`. Unexpected failures return `500 internal_error` without internals. Common codes:

| HTTP | code | Meaning |
|---|---|---|
| 400 | `validation_failed` (`details[]` path/message), `invalid_json`, `invalid_phone`, `invalid_cursor` | Schemas are strict: unknown fields are rejected (mass-assignment guard). |
| 401 | `authentication_required`, `invalid_token`, `session_revoked`, `otp_invalid`, `credential_required` (`details.required` per scope), `invalid_upload_token`, `upload_token_expired` | |
| 403 | `forbidden`, `insufficient_event_role`, `mfa_required`, `step_up_required`, `scope_not_granted`, `session_blocked`, `invalid_signature`, `link_expired`, `downloads_disabled`, `plan_feature_unavailable` | |
| 404 | `event_not_found`, `media_not_found`, … | Also returned for resources the caller may not know exist. |
| 409 | `event_state_forbids` (`details.state/action`), `invalid_state_transition`, `quota` codes (`event_storage_full`, `event_media_limit`), `incomplete_upload` (`details.missing[]`), `idempotent` conflicts | |
| 413/415 | `file_too_large`, `payload_too_large`, `unsupported_type` | |
| 422 | `unprocessable` family (`open_requires_public`, `passcode_not_set`, `feature_not_enabled`, `idempotency_key_reuse`, …) | |
| 429 | `rate_limited` (+ `Retry-After`), `otp_locked`, `session_upload_cap` | Limiter fails **closed** (503 `rate_limiter_unavailable`) if Redis is down. |
| 503 | `maintenance_mode`, `payment_provider_unavailable`, `sms_unavailable` | Writes blocked in maintenance mode; staff and reads continue. |

**Idempotency** — send `Idempotency-Key: <8–128 URL-safe chars>` on `POST /guest/uploads/intents`, `POST /events/:id/uploads/intents`, `POST /media/:id/complete`, `POST /payments/orders`, `POST /events/:id/exports`. Same key + same request ⇒ the stored response is replayed; same key + different request ⇒ `422 idempotency_key_reuse`; concurrent duplicate ⇒ `409 request_in_progress`. Payment callbacks are deduplicated by content hash.

**Pagination** — cursor-based and newest-first: `?limit=` (≤60 guests / ≤100 hosts) and `?cursor=` (opaque, keyset on `(timestamp µs, id)`); response `{ items, next_cursor|null }`.

**Rate limits (defaults, env-tunable)** — OTP request 3 / 10 min / phone + 20 / h / IP; OTP verify 10 / 15 min / phone (+ 5 attempts per challenge); join 60 / 10 min / IP; passcode 10 / 10 min / event+IP; upload intents 30 / min / session; reports 10 / h / session; rights requests 10 / h / IP; metrics client analytics 120 / 10 min / session.

---

## 1. Authentication — `AuthController`

| Endpoint | Request | Response | Notes |
|---|---|---|---|
| `POST /auth/request-otp` | `{phone, locale?: en|am}` | `{challenge_id, expires_in}` | Ethiopian mobile numbers only (`+251 9x/7x`, accepts `09…`, `9…`, `00251…`). Identical response whether or not the number is registered. Code is hashed, never returned/logged outside the `console` dev provider; SMS text is localized. |
| `POST /auth/verify-otp` | `{phone, code, device_label?, recovery?}` | `{access_token, access_expires_in, refresh_token\|cookie, session_id, user, is_new_user, mfa_required?, mfa_enrolled?}` | Single-use; creates the account on first success (sign-up = login). `recovery:true` revokes every other session (account recovery). Pending collaborator invitations for the number activate. |
| `POST /auth/refresh` | `{refresh_token?}` (or cookie) | new token pair | Rotation + reuse detection. |
| `POST /auth/logout` · `GET /sessions` · `DELETE /sessions/:id` · `POST /sessions/revoke-others` | — | session list `{id, device_label, user_agent, ip, last_used_at, current, mfa_verified}` | Device/session management. |
| `POST /auth/2fa/enroll` · `POST /auth/2fa/verify` | `{code}` | `{secret, otpauth_uri}` / new access token with `mfa=true` | Staff only. Secret encrypted at rest; TOTP replay-protected. |

## 2. Events — `EventsController`, `SharingController` (same controller)

| Endpoint | Auth | Contract |
|---|---|---|
| `POST /events` | host | Body (strict): `name` (1–120, Ethiopic OK), `type`, `starts_at`, `ends_at` (ISO with offset), optional `upload_opens_at`/`upload_closes_at` (default start / end+12 h, max 30 d window), `timezone` (default `Africa/Addis_Ababa`), `country` (only `ET`), `city` (required), `region`, `venue`, `host_name`, `language`, `brand_color`, plus settings below. Creates a **draft** with owner membership, upload/gallery tokens + join code, default folders. |
| `GET /events` · `GET /events/:id` | member | DTO incl. `state`, `allowed_actions`, `settings`, `lifecycle` (closure/retention/deletion dates, hold), `entitlement`, `usage`. |
| `PATCH /events/:id` | owner | Partial update. Core fields only in `draft/scheduled/live`; access/settings also in later states. Cross-field rules: `open` access needs `privacy_mode=public`; passcode mode needs a passcode; `comments_enabled`/`reactions_enabled` are rejected (feature flags off); `watermark`/original download need the plan. |
| `POST /events/:id/close` | owner | `{mode:'now'}` → `closing`; `{mode:'schedule', at}` sets `upload_closes_at`. |
| `POST /events/:id/extend` · `/archive` · `/restore` · `/delete` `{confirm_name}` · `/cancel-deletion` | owner | State-machine guarded (`event_state_forbids`). Delete = grace period (7–30 d, configurable) then purge. |
| `GET/POST /events/:id/members`, `DELETE …/:memberId` | owner (list: member) | Invite `{phone, role: moderator|photographer}`; plan seat limits (`plan_limit_*`). |
| `GET/POST /events/:id/folders`, `PATCH/DELETE /folders/:id` | owner/moderator (photographer: own) | `{name, publication_state: draft|published, download_allowed, watermark, cover_media_id}`. Draft folders are invisible to guests. |
| `PUT /events/:id/cover` | owner | Raw `image/jpeg|png|webp` ≤3 MB → re-encoded 1600×900 JPEG, metadata stripped. |
| `GET /events/:id/insights` | owner/moderator | uploads, unique contributors, approvals/pending/rejected/flagged/failed, median publish seconds, views, unique viewers, downloads, shares, busiest hour, peak concurrent uploads, storage vs quota (+alert level 70/85/95/100), 9-step funnel. |
| `GET /events/:id/share-links` | owner/moderator | `{upload_url, gallery_url, join_code, join_code_scope, passcode_set, slideshow_url, …}` — only after activation. |
| `POST /events/:id/qr` | owner/moderator | `{kind: upload|gallery, format: png|pdf, include_code?, size?}` → `image/png` or A5 printable PDF (vector QR, Amharic/English text). |
| `POST /events/:id/secrets/rotate` | owner | `{type: upload_token|gallery_token|join_code|passcode, passcode?, revoke_sessions?}` — old value stops working immediately; optionally strips the scope from existing guest sessions. |
| `POST /events/:id/live-ticket` | member | `{ticket, expires_in:60}` for the staff SSE channel. |

Settings (create/patch): `privacy_mode private|public`, `upload_access_mode open|code|passcode|verified_phone`, `gallery_access_mode …|view_only`, `join_code_scope upload|gallery|both`, `uploads_enabled`, `moderation_mode pre|post`, `downloads_enabled`, `allow_original_download`, `watermark_enabled`, `guest_name_required`, `captions_enabled`, `slideshow_enabled`, `report_hide_threshold`.

## 3. Guest access — `GuestController`

| Endpoint | Contract |
|---|---|
| `GET /events/:token/context` (public) | `:token` is an upload token (`u_…`), gallery token (`g_…`) or short join code. Returns minimal identity only: `{locator_kind, status: open|not_started|closed|unavailable, event:{name,host_name,venue,city,starts_at,language,cover_url,brand_color}, scopes:[{scope,mode,credential,credential_satisfied_by_locator}], can_upload, guest_name_required, captions_enabled, downloads_enabled, notice:{version,title,body,legal_status}, limits}`. Never ids, secrets, owner data. Unknown/draft → 404. |
| `POST /events/:token/verify` | Optional host-controlled phone verification: `{phone}` sends a code (per-event daily SMS cap), `{phone, code}` returns `{verification_proof}` (10 min JWT bound to the event). |
| `POST /events/:token/join` | `{code?, passcode?, verification_proof?, display_name?, device_id?, consent?:{notice_version, accepted:true}}` → `{token, expires_in, scopes, display_name, status}`. Rules: a scope is granted only when its mode's credential is satisfied; presenting an existing guest bearer **adds** scopes to the same session; upload scope requires explicit consent (recorded in `consent_records`) and a name if the host requires one; blocked devices get 403. `401 credential_required` lists what is missing. |
| `POST /guest/refresh` · `GET /guest/me` · `POST /guest/analytics {metric: capture_select|share}` | Session renewal; own session + contribution history (`state` only — never pending images); privacy-minimised funnel ping (allow-listed metrics). |

## 4. Media — `MediaController`

| Endpoint | Contract |
|---|---|
| `POST /guest/uploads/intents` · `POST /events/:id/uploads/intents` | `{mime, size, caption?, folder_id?, client_filename?}` (strict; filename is never used). Validates MIME allow-list, size ≤ 15 MB, lifecycle (`guest_upload`/`member_upload`), upload window, `uploads_enabled`, per-session cap & concurrency, event media/storage quota. Response `{media_id, upload:{url, protocol:'chunked-v1', chunk_url_template, token, expires_at, chunk_bytes, total_chunks, complete_url}}`. No bucket/key/credential is ever returned. |
| `PUT /uploads/:id/chunks/:n` | `X-Upload-Token`; body = raw bytes of exactly `chunk_bytes` (last chunk the remainder). Idempotent per chunk (retries overwrite). |
| `GET /uploads/:id` | Resume info `{state, received:[n…], total_chunks, chunk_bytes, declared_size}`. |
| `DELETE /uploads/:id` | Cancel (removes quarantine parts). |
| `POST /media/:id/complete` | Verifies all chunks and exact size, then enqueues processing. Idempotent; `409 incomplete_upload {missing}`. In `closing` state in-flight uploads may still complete. |
| `GET /guest/media` | Approved + ready + published-folder media only, newest first; items carry signed `urls.{thumb,gallery,viewer}` (30 min), `can_download`, `mine`. `?folder_id=&highlights=true&cursor=&limit=`. |
| `GET /guest/media/:id/download-link?variant=viewer|original` | 5-minute signed link; honours event download switch, folder permission, plan + host rule for originals. |
| `GET /m/:id/:variant?a=…&exp=…&sig=…` (public, signed) | Streams a derivative after re-checking the media's *current* state, so hide/reject/delete/suspension take effect immediately. Audience `pub` (guests), `stf` (host console), `adm` (audited elevated access). Originals are never inline. |
| `DELETE /guest/media/:id` | Guest self-deletes their own upload (D64). |
| `GET /events/:id/media?filter=newest|all|approved|pending|rejected|flagged|hidden|highlights&folder_id=` | Host/moderator management view (photographers see only their own). |
| `PATCH /media/:id` | `{is_highlight?, folder_id?, caption?}`. |
| `GET /live?ticket=` (SSE) | Public channel: `media.published` (with signed URLs), `media.removed`, `event.state`. Staff channel additionally `media.updated` for pending/rejected. Tickets are single-use, 60 s. |

**Processing states** `intent → uploading → uploaded → processing → ready | failed | duplicate | cancelled`; **moderation states** `pending, approved, rejected, hidden, flagged, deleted`. Failure codes surfaced to hosts: `invalid_magic`, `type_not_allowed`, `malware_detected`, `decode_failed`, `too_many_pixels`, `size_mismatch`, `processing_error`, `processing_timeout`, `abandoned`, `uploader_blocked`.

## 5. Moderation & reporting

| Endpoint | Auth | Contract |
|---|---|---|
| `GET /events/:id/moderation` | owner/moderator | Queue of `pending` + `flagged` with open reports and counts. |
| `POST /media/:id/approve|reject|hide|restore` · `DELETE /media/:id` | owner/moderator | `{reason?}`; valid transitions only; logged in `moderation_logs` + `audit_events`; realtime broadcast. |
| `POST /events/:id/moderation/bulk` | owner/moderator | `{action, media_ids[≤200], reason?}` → per-item `{id, ok, state|error}`. |
| `POST /media/:id/report` | guest (gallery scope) or member | `{reason: inappropriate|privacy_concern|impersonation|copyright|other, details?}`; repeats from the same session are no-ops; reaching the host's threshold auto-flags (hides from guests); 3 independent serious reports auto-escalate to the platform queue. Reporter receives a generic acknowledgement. |
| `GET /events/:id/reports`, `POST /reports/:id/escalate`, `GET /events/:id/moderation/logs` | owner/moderator | |
| `POST /events/:id/guests/:sessionId/block`, `POST /media/:id/block-uploader` | owner/moderator | `{hide_media?, reason?}` — blocks the session and its device; cancels in-flight uploads. |

## 6. Payments — `PaymentsController`

| Endpoint | Contract |
|---|---|
| `GET /plans?lang=` | ETB packages and add-ons (names/descriptions in en/am). |
| `POST /payments/orders` | `{event_id, plan_code}` (strict). Price comes from the server. Owner only; draft/active events; add-ons need a package; packages must be upgrades. Returns `{order_id, order_ref, amount_etb, currency:'ETB', state, checkout_url}`. Provider outage ⇒ `503 payment_provider_unavailable` (order marked `failed`, nothing granted). |
| `POST /events/:id/activate-trial` | Free trial plan, once per owner (D59). |
| `GET /payments/:orderId/status` | Owner; a still-pending order is re-verified with the provider (rate-limited), so the return-URL page works even if the callback is late. |
| `POST /payments/callbacks/:provider` | Raw-body signature check → duplicate-safe insert → **provider verification of status/amount/currency** → grant entitlement + invoice + activate event, all in one locked transaction. Responses: 200 `{outcome}`; 401 invalid signature; 503 if verification is unavailable (redelivery is re-processed). |
| `POST /dev/sandbox/pay` | Gateway simulator — 404 unless `PAYMENT_PROVIDER=sandbox` and not production. |

## 7. Exports — `ExportsController`

`POST /events/:id/exports {scope: full|folder|selected, folder_id?, media_ids?, variant: optimized|original}` (idempotent; original needs plan entitlement + stored originals) → `{id,state:'queued'}`; `GET /exports/:id/status`; `GET /events/:id/exports`; `GET /exports/:id/download` → `{url, expires_at}` (15-min signed link, audited); `GET /exports/:id/file?exp&sig` streams the ZIP (generated names only, no client filenames/metadata). Exports expire after 7 days.

## 8. Privacy — `PrivacyController`

`POST /privacy/requests {type: access|erasure|removal|objection|restriction|consent_withdrawal, requester_kind?, event_locator?, media_id?, contact?, details?}` — no account needed; a guest/host bearer links the request automatically; returns `{ref, access_token (shown once), state, due_at}`. `GET /privacy/requests/:ref` with `X-Request-Token` → `{state, due_at, timeline[], outcome_note}` (404 for any mismatch). `GET /policies/:kind?lang=` serves notices with `legal_status` (`draft_pending_legal_review` until counsel approves). Consent withdrawal removes the session's upload scope; removal requests flag the photo for review.

## 9. Admin — `AdminController` (`/v1/admin/*`, staff + 2FA)

Dashboard & KPIs · event search/detail (**metadata only**) · suspend/unsuspend/archive/restore/ops/legal-hold/grant · elevated media access (request → another super admin approves with TOTP → time-boxed, scoped, every view audited) · platform moderation (hide/delete without viewing) · organizations/users/support tickets · storage (objects, failures, orphan scan, backups, cost) · payments (orders, callbacks, reconciliation, refunds, invoices) · compliance (rights requests incl. access report, deletion jobs + evidence, incidents with 72 h clock, vendors with transfer-assessment gate, consent records) · audit search + hash-chain verification · settings & plan catalogue. Roles: `support_agent` reads and handles tickets/rights steps; destructive or financial actions are `super_admin` + fresh TOTP. See `API_ROUTES.md` for the exact policy per route.

Host-side support: `POST /support/tickets`, `GET /support/tickets`.

## Health & metrics
`GET /health/live`, `GET /health/ready` (database, redis, storage, antivirus), `GET /metrics` (Bearer `METRICS_TOKEN`; Prometheus text incl. `queue_jobs`, `media_processing_backlog`, `media_processed_total`, `payment_callbacks_total`, `http_request_duration_seconds`).
