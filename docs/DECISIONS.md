# Decision register status (spec §21)

The spec's "recommended default" is implemented for every decision unless noted. *Approved/Deferred/Rejected* is a product-owner status — here it records what the implementation does.

| ID | Decision | Status in this implementation | Where |
|---|---|---|---|
| D01 | No app install for guests | **Implemented** — PWA first-class | `apps/web` |
| D02/D70 | Android first, iOS later | **Implemented** Android; iOS deferred | `apps/mobile` |
| D03/D44 | No guest accounts; short-lived event sessions | **Implemented** | `guest.service.ts` |
| D04 | +251 OTP for hosts | **Implemented** | `auth.service.ts` |
| D05 | Private by default | **Implemented** (`privacy_mode=private`, `code` modes) | `events.service.ts` |
| D06 | Separate upload / gallery secrets | **Implemented** | `access_secrets` |
| D07 | Host-selectable moderation, approve-first default | **Implemented** (`moderation_mode pre|post`, default `pre`) | |
| D08 | No face recognition | **Not built**; no biometric data anywhere | |
| D09 | No video in MVP | **Not built**; MIME allow-list is photo-only; `FEATURE_VIDEO=false` | |
| D10/D36 | Comments later | **Deferred** (flag exists, API rejects enabling) | |
| D11 | Reactions optional later | **Deferred** (same) | |
| D12 | Basic slideshow | **Implemented** | `Slideshow.tsx` |
| D13/D61 | Originals plan-controlled and protected | **Implemented** (stored only if `original_storage`; never public; export/download need plan + host permission) | |
| D14 | No public indexing | **Implemented** (`X-Robots-Tag`, meta robots, no sitemap) | |
| D15 | Name optional | **Implemented** (host can require it) | |
| D16/D17 | Guest phone verification optional; foreign numbers possible | **Implemented** (`verified_phone` mode; `GUEST_PHONE_ALLOW_FOREIGN` flag, default off) | |
| D18/D19 | Ethiopia-only creation; no geo-blocking | **Implemented** | |
| D20/D21 | Ethiopian calendar; EN + AM | **Implemented** (web, mobile, QR PDF, SMS) | |
| D22/D25/D26 | ETB via licensed gateway; no credentials; no host funds | **Implemented** | `payments/*` |
| D23 | Direct telebirr design-ready | **Skeleton** (provider interface + placeholder) | `providers.ts` |
| D24 | Chapa if terms fit | **Implemented adapter** (initialize/verify/webhook signature); needs live onboarding | |
| D27/D28/D29 | Ethiopian hosting; no foreign CDN; no external AI | **Enforced** at boot + architecture | `config.ts` |
| D30 | Aggregated analytics | **Implemented** | `analytics.service.ts` |
| D31/D32/D33 | Retention 180 d / grace 7–30 d / backup expiry | **Implemented as configurable policy**; legal validation pending | LEGAL_FLAGS L1–L3 |
| D34 | Watermark optional | **Implemented** (event + folder; plan-gated) | |
| D35 | Captions optional ≤300 chars | **Implemented** | |
| D37/D40 | Photographer role MVP-lite; multi-event for pros | **Implemented** photographer role; multi-event = one account, many events | |
| D38/D39/D41 | White label, venue accounts, public discovery later | **Deferred** | |
| D42/D43 | In-app/browser notifications; push optional | **Implemented** (SMS only transactional; Android local notifications; no push vendor) | |
| D45 | Printable QR PNG/PDF | **Implemented** | `sharing.service.ts` |
| D46 | Short code 6–9 chars | **Implemented** (8 chars, unambiguous alphabet) | |
| D47 | Basic branding | **Implemented** (cover + brand colour) | |
| D48 | Event folders | **Implemented** | |
| D49 | Filters by date/folder/highlight, no filename search | **Implemented** | |
| D50 | No AI moderation | **Not built** | |
| D51 | Abuse blocking | **Implemented** (session + device block) | |
| D52 | Admin media access restricted & audited | **Implemented** (four-eyes, time-boxed, scoped, audited) | |
| D53/D54/D55/D56/D57 | DPO, controller allocation, terms/DPA, breach playbook, tax | **Technical support only; decisions flagged** | LEGAL_FLAGS |
| D58/D59/D60 | Per-event pricing; limited trial; never silent overage | **Implemented** (trial once per owner; explicit upgrades/add-ons) | |
| D62/D63 | Guest download host-controlled; gallery public only by opt-in | **Implemented** | |
| D64 | Guest self-delete / report | **Implemented** | |
| D65 | Rights language | **Flagged** (L17) | |
| D66 | Support channels | **In-app ticket implemented**; phone/email are operational | |
| D67 | Tiered SLA | **Operational** (not software) | |
| D68 | RPO ≤ 15 m / RTO ≤ 2 h | **Targets documented; drill measures RTO**; WAL archiving needs production infra | DEPLOYMENT §4 |
| D69 | Hosting provider shortlist | **Operational**; configuration is provider-agnostic | |

## Implementation-level technical decisions (not in the spec)

| Decision | Reason |
|---|---|
| Upload chunks go **through the API** (not presigned PUT to MinIO) | Hides storage entirely (no bucket/key/credential leaves the platform), works behind nginx on any network, resume protocol is simple (`GET /uploads/:id`), and per-chunk rate limiting/authorization is uniform. Cost: API handles upload bytes (1 MiB chunks, stateless, scale horizontally). |
| Server-Sent Events + Redis pub/sub instead of WebSockets | One-directional fan-out is all the gallery needs, proxies friendlier, native `EventSource` reconnect, no extra library. Spec allows "WebSocket/SSE". |
| SQL migrations + `pg`, no ORM | Explicit schema/indexes/constraints, partial and keyset indexes, no hidden queries; fewer moving parts for audit. |
| One Next.js app for guest/host/admin | Single deployable; admin separation is by route + mandatory 2FA + role; can be fronted by a separate nginx host. |
| Original photo kept only when the plan includes it | Controls storage cost (R3); guests rarely need originals (spec 8.2). |
| Gallery derivative 1280 px + viewer 2560 px | See IMPLEMENTATION_MAP "clarification". |
