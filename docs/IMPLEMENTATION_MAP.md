# Implementation map: specification → repository

Source of truth: *Ethiopia Event Photo Sharing Platform — Final Product, Feature, Architecture, Compliance and Launch Blueprint* (2 Oct 2026).
The repository started empty, so there was no existing code to reuse; every module below is new. No requirement was reorganised into phases; every "MVP / required" item is implemented, "later / deferred" items are **not** implemented but the architecture has a defined extension point.

## Stack decisions (spec §14.1 — one backend, no duplicated stacks)

| Spec layer | Choice | Where | Why / spec link |
|---|---|---|---|
| Backend API + workers | **NestJS / TypeScript** (single backend) | `apps/api` | Spec: "NestJS/TypeScript or FastAPI … do not use multiple backends". Workers are the same codebase run with `APP_ROLE=worker`. |
| Database | **PostgreSQL 16** + SQL migrations (no ORM) | `apps/api/migrations`, `src/infra/migrate.ts` | §14.1, brief §14 "use migrations". |
| Cache / queue / realtime | **Redis** (BullMQ queues, rate limits, pub/sub for SSE) | `src/infra/{redis,queue}.service.ts`, `src/gallery/realtime.service.ts` | §8.3, §14.1. |
| Object storage | **S3-compatible (MinIO)**, three private buckets: quarantine / media / exports | `src/infra/storage.service.ts`, `infra/docker-compose.yml` | §14.1; never public, never exposed to clients. |
| Media processing | **libvips (sharp)**, in-process WASM HEIC decoder (no external service) | `src/media/image.service.ts` | §8.1, brief §3 "no foreign image-processing APIs". |
| Malware scan | **ClamAV (clamd INSTREAM)**, fail-closed; EICAR test mode for dev/CI only | `src/media/scan.service.ts` | §8.1, §18. |
| Guest web/PWA + Admin + Host console | **Next.js 15 / React 19** (one app, three route areas) | `apps/web` | §14.1. One deployable keeps the edge simple; admin lives under `/admin` with its own 2FA gate and can be split behind a different nginx host without code changes. |
| Android | **Flutter (Android first)** | `apps/mobile` | §6.4, D02, D70. |
| Edge | **nginx** (TLS, limits, SSE passthrough, raw callback body) | `infra/nginx/nginx.conf` | §14.1. |
| Monitoring | **Prometheus + Grafana**, structured logs | `src/infra/metrics.service.ts`, `infra/prometheus`, `infra/grafana` | §14.1, §16. |
| Containers | **Docker Compose** (no Kubernetes) | `infra/docker-compose.yml`, `apps/api/Dockerfile` | §14.1. |

## Surfaces

| Spec surface | Implementation |
|---|---|
| Platform Admin (§6.1) | `apps/web/src/app/admin/*`, API `src/admin/*` |
| Event Owner console (§6.2) | `apps/web/src/app/host/*`, `src/components/host/*`, API `src/events`, `src/moderation`, `src/exports`, `src/payments` |
| Guest web/PWA (§6.3) | `apps/web/src/app/j/[token]`, `src/components/guest/*`, `src/lib/upload-queue.ts`, `public/sw.js`, `manifest.webmanifest` |
| Native Android (§6.4) | `apps/mobile` |
| Photographer workspace (§6.5, MVP-lite D37) | Photographer role: scoped invites, folders (draft/published), highlights, batch chunked uploads, own-media scope — `src/events/events.service.ts`, `src/moderation/moderation.service.ts`, `src/components/host/GalleryTab.tsx` |
| Live slideshow (D12) | `apps/web/src/components/guest/Slideshow.tsx` |
| Public event page, comments, reactions, chat, video, face matching (§6.6 / §20 later) | **Not built.** `comments_enabled` / `reactions_enabled` exist as feature-flagged settings (default false; API refuses to enable them) so they can be added without schema changes. |

## Requirement → code (by spec section)

| Spec § | Requirement | Code | Test |
|---|---|---|---|
| 3.3 | Ethiopia-only events, ETB-only billing, +251 owners, EAT/UTC | `events.service.ts` (country literal `ET`, `CHECK (country='ET')`), `common/phone.ts`, `plans.currency CHECK ('ETB')` | `core-flow`, `payments`, `unit/core` |
| 3.4 / D19 | No IP geo-blocking by default | `FEATURE_GEO_RESTRICTION=false`, no geo code path | — |
| 4 / 4.1 | RBAC + event membership + state + media state + action | `events/access.service.ts` (role matrix), `auth/auth.guard.ts` (default-deny), `events/lifecycle.ts` | `team`, `security` (route-meta introspection) |
| 5 A–H | Host/guest/moderation/closure/report/recovery/refund journeys | Controllers listed in `docs/API.md` | `e2e/full-workflow`, browser e2e |
| 7 | 9-state lifecycle, real backend logic | `events/lifecycle.ts` (transition + action tables), `lifecycle.service.ts` (single transition point + scheduler tick) | `lifecycle`, `unit/core` |
| 7.1 | Separate upload / gallery secrets, 5 access modes, short code | `access_secrets`, `guest/guest.service.ts`, `events/sharing.service.ts` | `core-flow` ("code mode", "passcode mode", "verified-phone") |
| 8.1 | Full pipeline: client validation → intent → signed target → chunked upload → quarantine → MIME/magic → AV → decode check → metadata → EXIF strip → hashes → derivatives → moderation → publish → realtime → retention | `media/upload.service.ts`, `media/processing.service.ts`, `image.service.ts`, `scan.service.ts` | `core-flow` (abuse cases), `unit/media`, `e2e/network` |
| 8.2 | 15 MB cap, 480 px thumb, ≤2560 px viewer, JPEG q85, 300-char captions, client filename ignored | `config.ts`, `image.service.ts`, object keys built from UUIDs only | `unit/media`, `core-flow` |
| 8.3 | Token-scoped, cursor-paginated, lazy gallery; Redis fan-out; only approved media broadcast | `gallery/gallery.service.ts`, `realtime.service.ts` (separate `public` / `staff` channels) | `core-flow`, `e2e/full-workflow` |
| 9.1–9.2 | Data minimisation, consent records, privacy notice, report/removal | `consent_records`, `policy_documents`, `privacy/*`, guest notice in en/am | `exports-privacy` |
| 9.3 | Registration / DPO | Out of code scope — **flagged** in `docs/LEGAL_FLAGS.md` | — |
| 9.4 | Data residency, vendor register, no foreign AI | `assertProductionSafety` (refuses foreign-cloud endpoints), `vendors` table with transfer-assessment gate, no third-party image calls | `unit/core`, `admin` |
| 9.5 | Breach response, 72 h clock from explicit discovery time | `incidents` + `incident_log`, `/admin/compliance/incidents` | `admin` |
| 9.6 | Reports, hide, moderation log, rate limits, per-event quotas, escalation | `moderation/*`, `redis.service.ts#hit`, `entitlements.service.ts#usage` | `core-flow`, `admin` |
| 10 | EN/AM resources, Ethiopic Unicode, Gregorian + Ethiopian calendar, E.164, EAT | `apps/web/src/locales/*.json`, `apps/mobile/lib/l10n/*.arb`, calendar libs in api/web/mobile | `web/tests/i18n`, `mobile/test/core`, browser e2e |
| 11 | Low-bandwidth: compression, resumable, backoff, persistent queue, small derivatives, throttling | `web/src/lib/upload-queue.ts`, `mobile/lib/data/upload_engine.dart`, `upload.service.ts` | `e2e/network` (Ethio telecom / Safaricom / Wi-Fi / 3G / outage profiles), `web/tests`, `mobile/test` |
| 12 | Provider abstraction, callbacks verified, idempotent, reconciliation, refunds, no credentials | `payments/*` | `payments` (12 cases) |
| 12.3 | VAT/invoicing | Invoice records with `tax_status='unvalidated'` until accountant confirms — **flagged** | `payments` |
| 13 | Legal documents, vendor contracts | Draft policy texts flagged `draft_pending_legal_review`; `docs/LEGAL_FLAGS.md` | — |
| 15.1 | Core entities | `migrations/001_core_schema.sql` (all 16 required entities + supporting tables) | all |
| 15.2 | API surface | `docs/API.md` | all |
| 15.3 | API security | Short-lived tokens, rotating refresh with reuse detection, hashed event tokens, idempotency keys, rate limits, zod validation, signed URLs, admin 2FA, server-side authz | `security`, `core-flow`, `admin` |
| 16 | Admin controls (dashboard, storage 70/85/95/100 %, orphan scan, backlog, data rights, incidents, vendors) | `admin/*`, `processing.service.ts#quotaAlerts` | `admin` |
| 17 | Funnel + KPIs, privacy-minimised | `analytics/analytics.service.ts` (daily aggregates + per-session first-step flags; no event payloads) | `admin` |
| 18 | Security & reliability | See `docs/ARCHITECTURE.md` §Security; backups `infra/scripts` | `security`, `e2e/backup-restore` |
| 19 | Acceptance tests (30 items) | `docs/TESTING.md` maps each of the 30 to a test | all suites |
| 20 | MVP boundary | Deferred items absent; see table above | — |
| 21 | Decision register D01–D70 | `docs/DECISIONS.md` | — |
| 23 | Roadmap phases | Not reorganised; all Phase 1 + 2 items present | — |

## Required clarification of one spec point

Spec 8.2 lists "Gallery derivative: up to 2560 px" and 8.1 lists thumbnail + gallery + viewer derivatives. The implementation generates **thumb 480 px, gallery 1280 px (grid/masonry), viewer 2560 px (full-screen)** so the grid stays light on weak links; the 2560 px cap from the spec is the viewer size. All sizes are env/config driven (`DERIV_*_PX`).
