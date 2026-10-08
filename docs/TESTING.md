# Testing

Infrastructure for tests: `docker compose -f infra/docker-compose.yml --env-file .env up -d` (Postgres, Redis, MinIO). Integration/e2e tests create their own database `event_test`, Redis db 1 and `test-*` buckets, run the real migrations, and use the real BullMQ workers, sharp pipeline and MinIO — nothing is mocked except SMS (in-memory outbox), the sandbox payment gateway and ClamAV (EICAR mode).

| Suite | Command (in `apps/api`) | What it covers |
|---|---|---|
| Unit | `npm run test:unit` | Phone normalisation, Ethiopian calendar, AES/HMAC/scrypt, **RFC 6238 TOTP vector**, lifecycle tables, **production safety assertions**, audit hash, magic-byte sniffing, **GPS/EXIF-free derivatives**, pHash, decode-bomb limit, EICAR/clamd fail-closed. |
| Integration | `npm run test:integration` | Auth/OTP/refresh/sessions, event creation & privacy rules, access modes, multi-chunk upload pipeline, abuse cases, moderation/reports/blocking, quotas, downloads, payments (callbacks, idempotency, outage, reconciliation, refunds, upgrades), lifecycle/retention/deletion/legal hold, exports, privacy rights, roles, admin, audit, security. |
| End-to-end | `npm run test:e2e` | The whole definition-of-done workflow with real workers + SSE; Ethiopian network profiles; worker-recovery; backup/restore drill. |
| Focused | `npm run test:security` · `test:payments` · `test:media` | Subsets. |
| Web unit | `cd apps/web && npm test` | EN/AM resource parity, Ethiopic text, Ethiopian calendar/EAT, **upload engine** (chunking, backoff, offline, resume, persistence). |
| Browser e2e | `cd apps/web && WEB_URL=http://localhost:3100 npx playwright test` | Real Android-Chrome-profile and desktop browser runs against the live stack (needs API on :4000 with `OTP_FIXED_CODE=123456`, relaxed OTP limits, and the built web app). |
| Flutter | `cd apps/mobile && flutter test` | Upload engine (resume after kill, backoff, offline, Wi-Fi-only originals, data saver, usage counters), secure deep links, session vault, API client, ARB parity. |

## Acceptance checklist (spec 19.1 / brief §24) → evidence

| # | Criterion | Test(s) |
|---|---|---|
| 1 | Host signs up with +251 OTP | `core-flow` "#1 signs up…", browser `host.spec` |
| 2 | Create + activate event | `core-flow` "#2 host creates…", `payments`, `e2e/full-workflow` |
| 3 | QR opens guest experience, no app | `core-flow` "#3 QR/link…", browser `guest.spec` (plain mobile browser) |
| 4 | Android Chrome capture/upload | browser `guest.spec` (Pixel 5 profile: file chooser with `capture` input + gallery input) |
| 5 | Multiple photos | `core-flow` multi-chunk, `guest.spec` (2 photos), `e2e/full-workflow` (3 concurrent) |
| 6 | Progress visible | `core-flow` "#4/#5/#6", `web/tests/upload-queue`, `guest.spec` ("Uploading n%") |
| 7 | Retry works | `web/tests`, `mobile/test`, `e2e/network` (retry + dedupe), `core-flow` (re-sent chunk) |
| 8 | Temporary interruption handled | `e2e/network` (connection_loss, 3G), `guest.spec` (offline → waiting → resume), `mobile/test` (offline, kill/restart) |
| 9 | Unapproved invisible to guests | `core-flow` "#9 unapproved…" (list, signed URL, download, report, live channel), `e2e/full-workflow` |
| 10 | Bulk approve/reject | `core-flow` "#10", browser `host.spec` |
| 11 | Export event | `exports-privacy` "#11", `e2e/full-workflow`, browser `host.spec` |
| 12 | Auto close | `lifecycle` "#12" |
| 13 | Expired events enter deletion lifecycle, auditable | `lifecycle` "#13…", `e2e/full-workflow` |
| 14 | Admin search without exposing media | `admin` "#14", browser `admin.spec` |
| 15 | Callbacks idempotent | `payments` "#15" |
| 16 | Invalid callback does not activate | `payments` "#16" (+ claimed-success, mismatch) |
| 17 | OTP brute-force limited | `core-flow` "#17" |
| 18 | Event IDs cannot be guessed | `core-flow` "#18" |
| 19 | No GPS EXIF in public derivatives | `unit/media` (fixture proven to contain GPS), `core-flow` "#19" (bytes served over HTTP) |
| 20 | Deletion/privacy requests auditable | `exports-privacy` "Privacy and data-subject rights" |
| 21 | Privileged actions in audit logs | `admin` "#21…", hash-chain tamper test |
| 22 | Usable on slow 4G with 2–3 MB image | `e2e/network` (slow_4g: 4000×3000 JPEG ≈ 44 s virtual), `web/tests` (compression plan), `guest.spec` (throttled 3G) |
| 23–25 | English / Amharic / Ethiopic | `web/tests/i18n`, `mobile/test/core`, `guest.spec` Amharic test (font loaded, no overflow), SMS template test in `core-flow`, Ethiopic names end-to-end |
| 26 | Ethio telecom & Safaricom Ethiopia | `e2e/network` profiles `ethio_telecom_4g/3g`, `safaricom_4g` (modelled latency/bandwidth/loss; **real-network pilot on both operators is a launch checklist item**) |
| 27 | Backup/restore | `e2e/backup-restore` (encrypted dump → throw-away DB → counts + audit chain + RTO) |
| 28 | Worker failure recovery | `lifecycle` sweeper test, `e2e/network` "#28 queue durability" |
| 29 | Queue backlog observable | `security` "#29" (`queue_jobs` metric), admin dashboard |
| 30 | Payment provider outage handled | `payments` "#30" |
| — | Abuse: fake MIME, oversized, repeated reports, quota exhaustion, unauthorized access | `core-flow` abuse/report/quota tests, `security`, `team` |

## Not automatable here (must be done before public launch — spec 24)
Pilot on **real** Ethio telecom and Safaricom Ethiopia networks and low/mid-range Android devices (the network matrix above is a model, not a SIM test); burst test with a representative event; third-party penetration test; real payment-provider sandbox/live onboarding tests; production restore drill on the contracted Ethiopian infrastructure.
