-- 001_core_schema.sql
-- Ethiopia Event Photo Sharing Platform - core relational schema (PostgreSQL 14+).
-- Conventions
--   * Primary keys are random UUIDs (gen_random_uuid) - never sequential/guessable.
--   * Public/guest-facing locators are separate high-entropy tokens stored hashed (access_secrets).
--   * Enumerations are CHECK constraints (cheap to evolve through further migrations).
--   * All timestamps are timestamptz (UTC); local EAT presentation happens at the edge.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------- identity
CREATE TABLE organizations (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legal_name       text NOT NULL,
  tin              text,                              -- tax id, business accounts only (optional)
  verification_state text NOT NULL DEFAULT 'unverified'
                   CHECK (verification_state IN ('unverified','pending','verified','rejected')),
  billing_profile  jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_hash       text NOT NULL UNIQUE,              -- HMAC blind index of E.164 (lookup)
  phone_enc        text NOT NULL,                     -- AES-256-GCM encrypted E.164
  phone_last4      text NOT NULL,                     -- masked display / support
  display_name     text,
  status           text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','deleted')),
  locale           text NOT NULL DEFAULT 'en' CHECK (locale IN ('en','am')),
  platform_role    text NOT NULL DEFAULT 'none' CHECK (platform_role IN ('none','super_admin','support_agent')),
  totp_secret_enc  text,
  totp_enabled     boolean NOT NULL DEFAULT false,
  totp_last_step   bigint,                            -- replay protection for TOTP
  organization_id  uuid REFERENCES organizations(id) ON DELETE SET NULL,
  trial_used_at    timestamptz,                       -- one free trial event per owner (D59)
  created_at       timestamptz NOT NULL DEFAULT now(),
  last_login_at    timestamptz
);
CREATE INDEX users_org_idx ON users(organization_id);
CREATE INDEX users_role_idx ON users(platform_role) WHERE platform_role <> 'none';

-- Device sessions for hosts/staff. refresh_hash rotates on every refresh; family_id enables reuse detection.
CREATE TABLE sessions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  family_id        uuid NOT NULL DEFAULT gen_random_uuid(),
  refresh_hash     text NOT NULL UNIQUE,
  prev_refresh_hash text,                              -- previous token: presenting it again = reuse => session revoked
  device_label     text,
  user_agent       text,
  ip               inet,
  mfa_verified     boolean NOT NULL DEFAULT false,
  mfa_verified_at  timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  last_used_at     timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz NOT NULL,
  revoked_at       timestamptz,
  revoke_reason    text
);
CREATE INDEX sessions_user_idx ON sessions(user_id) WHERE revoked_at IS NULL;
CREATE INDEX sessions_family_idx ON sessions(family_id);
CREATE INDEX sessions_prev_refresh_idx ON sessions(prev_refresh_hash) WHERE prev_refresh_hash IS NOT NULL;

CREATE TABLE otp_challenges (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  purpose          text NOT NULL CHECK (purpose IN ('host_login','guest_verify')),
  phone_hash       text NOT NULL,
  event_id         uuid,                              -- for guest_verify
  code_hash        text NOT NULL,
  attempts         int NOT NULL DEFAULT 0,
  expires_at       timestamptz NOT NULL,
  consumed_at      timestamptz,
  ip               inet,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX otp_phone_idx ON otp_challenges(phone_hash, purpose, created_at DESC);

-- ---------------------------------------------------------------- commercial catalogue
CREATE TABLE plans (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code             text NOT NULL UNIQUE,
  kind             text NOT NULL DEFAULT 'package' CHECK (kind IN ('package','addon')),
  name_en          text NOT NULL,
  name_am          text NOT NULL,
  description_en   text,
  description_am   text,
  price_etb        numeric(12,2) NOT NULL CHECK (price_etb >= 0),
  currency         text NOT NULL DEFAULT 'ETB' CHECK (currency = 'ETB'),
  storage_bytes    bigint NOT NULL CHECK (storage_bytes >= 0),
  max_media        int NOT NULL,
  retention_days   int NOT NULL,                      -- post-closure online retention granted
  original_storage boolean NOT NULL DEFAULT false,
  allow_original_export boolean NOT NULL DEFAULT false,
  max_collaborators int NOT NULL DEFAULT 1,
  photographer_seats int NOT NULL DEFAULT 0,
  concurrent_uploads int NOT NULL DEFAULT 4,
  branding         boolean NOT NULL DEFAULT false,
  watermark        boolean NOT NULL DEFAULT false,
  features         jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_trial         boolean NOT NULL DEFAULT false,
  active           boolean NOT NULL DEFAULT true,
  sort_order       int NOT NULL DEFAULT 0,
  created_at       timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- events
CREATE TABLE events (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_code      text NOT NULL UNIQUE,              -- opaque, searchable by staff; not an access credential
  owner_id         uuid NOT NULL REFERENCES users(id),
  organization_id  uuid REFERENCES organizations(id),
  name             text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  type             text NOT NULL CHECK (type IN ('wedding','birthday','graduation','conference','corporate','party','family','cultural','other')),
  starts_at        timestamptz NOT NULL,
  ends_at          timestamptz NOT NULL,
  upload_opens_at  timestamptz NOT NULL,
  upload_closes_at timestamptz NOT NULL,
  timezone         text NOT NULL DEFAULT 'Africa/Addis_Ababa',
  country          char(2) NOT NULL DEFAULT 'ET' CHECK (country = 'ET'),   -- Ethiopia-only boundary (D18)
  city             text NOT NULL CHECK (char_length(city) BETWEEN 1 AND 80),
  region           text,
  venue            text,
  host_name        text,
  language         text NOT NULL DEFAULT 'en' CHECK (language IN ('en','am')),
  cover_object_key text,
  brand_color      text CHECK (brand_color IS NULL OR brand_color ~ '^#[0-9a-fA-F]{6}$'),
  state            text NOT NULL DEFAULT 'draft'
                   CHECK (state IN ('draft','scheduled','live','closing','read_only','archived','deletion_pending','deleted','suspended')),
  prev_state       text,                              -- restored on un-suspend / cancel deletion
  privacy_mode     text NOT NULL DEFAULT 'private' CHECK (privacy_mode IN ('private','public')),
  upload_access_mode  text NOT NULL DEFAULT 'code'
                   CHECK (upload_access_mode IN ('open','code','passcode','verified_phone')),
  gallery_access_mode text NOT NULL DEFAULT 'code'
                   CHECK (gallery_access_mode IN ('open','code','passcode','verified_phone','view_only')),
  join_code_scope  text NOT NULL DEFAULT 'upload' CHECK (join_code_scope IN ('upload','gallery','both')),
  uploads_enabled  boolean NOT NULL DEFAULT true,
  moderation_mode  text NOT NULL DEFAULT 'pre' CHECK (moderation_mode IN ('pre','post')),
  comments_enabled boolean NOT NULL DEFAULT false,    -- feature-flagged, deferred (D10)
  reactions_enabled boolean NOT NULL DEFAULT false,   -- feature-flagged, deferred (D11)
  downloads_enabled boolean NOT NULL DEFAULT true,
  allow_original_download boolean NOT NULL DEFAULT false,
  watermark_enabled boolean NOT NULL DEFAULT false,
  guest_name_required boolean NOT NULL DEFAULT false,
  captions_enabled boolean NOT NULL DEFAULT false,
  slideshow_enabled boolean NOT NULL DEFAULT true,
  closing_uploads  text NOT NULL DEFAULT 'reject' CHECK (closing_uploads IN ('reject')),
  report_hide_threshold int NOT NULL DEFAULT 1 CHECK (report_hide_threshold >= 1),
  activated_at     timestamptz,
  closed_at        timestamptz,
  read_only_at     timestamptz,
  archived_at      timestamptz,
  retention_until  timestamptz,
  deletion_requested_at timestamptz,
  deletion_deadline timestamptz,
  deleted_at       timestamptz,
  suspended_at     timestamptz,
  suspended_reason text,
  legal_hold       boolean NOT NULL DEFAULT false,
  storage_bytes    bigint NOT NULL DEFAULT 0,
  media_count      int NOT NULL DEFAULT 0,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at >= starts_at),
  CHECK (upload_closes_at > upload_opens_at)
);
CREATE INDEX events_owner_idx ON events(owner_id);
CREATE INDEX events_state_idx ON events(state);
CREATE INDEX events_open_idx ON events(upload_opens_at) WHERE state = 'scheduled';
CREATE INDEX events_close_idx ON events(upload_closes_at) WHERE state = 'live';
CREATE INDEX events_retention_idx ON events(retention_until) WHERE state IN ('read_only','archived');
CREATE INDEX events_deletion_idx ON events(deletion_deadline) WHERE state = 'deletion_pending';
CREATE INDEX events_city_idx ON events(lower(city));

CREATE TABLE event_members (
  event_id         uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id          uuid REFERENCES users(id) ON DELETE CASCADE,
  invite_phone_hash text,                              -- pending invitation until the invitee logs in
  role             text NOT NULL CHECK (role IN ('owner','moderator','photographer')),
  status           text NOT NULL DEFAULT 'active' CHECK (status IN ('invited','active','removed')),
  invited_by       uuid REFERENCES users(id),
  can_manage_billing boolean NOT NULL DEFAULT false,
  created_at       timestamptz NOT NULL DEFAULT now(),
  id               uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY
);
CREATE UNIQUE INDEX event_members_user_uq ON event_members(event_id, user_id) WHERE user_id IS NOT NULL AND status <> 'removed';
CREATE UNIQUE INDEX event_members_invite_uq ON event_members(event_id, invite_phone_hash) WHERE invite_phone_hash IS NOT NULL AND status = 'invited';
CREATE INDEX event_members_user_idx ON event_members(user_id) WHERE status = 'active';
CREATE INDEX event_members_invite_idx ON event_members(invite_phone_hash) WHERE status = 'invited';

CREATE TABLE event_folders (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id         uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  name             text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  kind             text NOT NULL DEFAULT 'custom' CHECK (kind IN ('pre_event','ceremony','reception','highlights','custom')),
  sort_order       int NOT NULL DEFAULT 0,
  cover_media_id   uuid,
  publication_state text NOT NULL DEFAULT 'published' CHECK (publication_state IN ('draft','published')),
  download_allowed boolean NOT NULL DEFAULT true,
  watermark        boolean NOT NULL DEFAULT false,
  created_by       uuid REFERENCES users(id),
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX event_folders_event_idx ON event_folders(event_id, sort_order);

-- Upload / gallery / join-code locators and the passcode. Only hashes are used for lookup.
-- token_enc lets the owner re-display share links/QR (never exposed to guests or staff).
CREATE TABLE access_secrets (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id         uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  secret_type      text NOT NULL CHECK (secret_type IN ('upload_token','gallery_token','join_code','passcode')),
  token_hash       text NOT NULL,                      -- HMAC(pepper, token) or scrypt hash for passcode
  token_enc        text,                               -- AES-GCM(token); NULL for passcode
  created_by       uuid REFERENCES users(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  revoked_at       timestamptz
);
CREATE UNIQUE INDEX access_secrets_lookup_uq ON access_secrets(token_hash) WHERE secret_type <> 'passcode' AND revoked_at IS NULL;
CREATE UNIQUE INDEX access_secrets_active_uq ON access_secrets(event_id, secret_type) WHERE revoked_at IS NULL;

CREATE TABLE guest_sessions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id         uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  token_hash       text NOT NULL,
  scopes           text[] NOT NULL DEFAULT '{}',        -- subset of {upload,gallery}
  display_name     text,
  phone_hash       text,
  phone_verified_at timestamptz,
  device_hash      text,
  ip_hash          text,
  user_agent       text,
  upload_count     int NOT NULL DEFAULT 0,
  blocked_at       timestamptz,
  block_reason     text,
  first_gallery_view_at timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz NOT NULL
);
CREATE INDEX guest_sessions_event_idx ON guest_sessions(event_id);
CREATE INDEX guest_sessions_device_idx ON guest_sessions(event_id, device_hash);

CREATE TABLE blocked_devices (
  event_id         uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  device_hash      text NOT NULL,
  reason           text,
  created_by       uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id, device_hash)
);

-- ---------------------------------------------------------------- media
CREATE TABLE media (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id         uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  folder_id        uuid REFERENCES event_folders(id) ON DELETE SET NULL,
  uploader_session_id uuid REFERENCES guest_sessions(id) ON DELETE SET NULL,
  uploader_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  upload_state     text NOT NULL DEFAULT 'intent'
                   CHECK (upload_state IN ('intent','uploading','uploaded','processing','ready','failed','duplicate','cancelled')),
  moderation_state text NOT NULL DEFAULT 'pending'
                   CHECK (moderation_state IN ('pending','approved','rejected','hidden','flagged','deleted')),
  is_highlight     boolean NOT NULL DEFAULT false,
  caption          text CHECK (caption IS NULL OR char_length(caption) <= 300),
  declared_mime    text NOT NULL,
  declared_size    bigint NOT NULL CHECK (declared_size > 0),
  mime             text,                                -- detected (magic bytes)
  size_bytes       bigint,
  stored_bytes     bigint NOT NULL DEFAULT 0,           -- original (if retained) + derivatives
  width            int,
  height           int,
  orientation      int,
  captured_at      timestamptz,
  sha256           text,
  phash            bigint,
  dup_of_media_id  uuid,
  near_dup_of_media_id uuid,
  chunk_size       int NOT NULL,
  total_chunks     int NOT NULL,
  quarantine_prefix text NOT NULL,                      -- opaque, never returned to clients
  original_key     text,
  failure_code     text,
  failure_detail   text,
  processing_attempts int NOT NULL DEFAULT 0,
  upload_started_at timestamptz,
  completed_at     timestamptz,
  processed_at     timestamptz,
  published_at     timestamptz,
  moderated_at     timestamptz,
  moderated_by     uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  deleted_at       timestamptz
);
-- gallery keyset pagination: newest first by (published_at, id)
CREATE INDEX media_gallery_idx ON media(event_id, published_at DESC, id DESC)
  WHERE upload_state = 'ready' AND moderation_state = 'approved';
CREATE INDEX media_event_state_idx ON media(event_id, moderation_state, created_at DESC);
CREATE INDEX media_uploader_idx ON media(uploader_session_id, created_at DESC);
CREATE INDEX media_processing_idx ON media(upload_state, completed_at) WHERE upload_state IN ('uploaded','processing');
CREATE INDEX media_stale_idx ON media(created_at) WHERE upload_state IN ('intent','uploading');
CREATE UNIQUE INDEX media_event_sha_uq ON media(event_id, sha256) WHERE sha256 IS NOT NULL AND upload_state = 'ready' AND deleted_at IS NULL;
CREATE INDEX media_folder_idx ON media(folder_id);

CREATE TABLE upload_parts (
  media_id         uuid NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  part_no          int NOT NULL CHECK (part_no >= 0),
  size_bytes       int NOT NULL,
  sha256           text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (media_id, part_no)
);

CREATE TABLE media_derivatives (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  media_id         uuid NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  variant          text NOT NULL CHECK (variant IN ('thumb','gallery','viewer','original')),
  object_key       text NOT NULL,
  mime             text NOT NULL,
  width            int,
  height           int,
  byte_size        bigint NOT NULL,
  checksum         text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (media_id, variant)
);

-- ---------------------------------------------------------------- moderation
CREATE TABLE moderation_reports (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id         uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  media_id         uuid NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  reporter_session_id uuid REFERENCES guest_sessions(id) ON DELETE SET NULL,
  reporter_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  reason           text NOT NULL CHECK (reason IN ('inappropriate','privacy_concern','impersonation','copyright','other')),
  details          text CHECK (details IS NULL OR char_length(details) <= 500),
  severity         int NOT NULL DEFAULT 1,
  status           text NOT NULL DEFAULT 'open' CHECK (status IN ('open','actioned','dismissed','escalated')),
  action           text,
  reviewer_id      uuid REFERENCES users(id),
  reviewer_scope   text CHECK (reviewer_scope IN ('host','platform')),
  escalated_at     timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  resolved_at      timestamptz
);
CREATE INDEX reports_event_idx ON moderation_reports(event_id, status, created_at DESC);
CREATE INDEX reports_media_idx ON moderation_reports(media_id);
CREATE UNIQUE INDEX reports_dedupe_uq ON moderation_reports(media_id, reporter_session_id) WHERE reporter_session_id IS NOT NULL AND status = 'open';
CREATE INDEX reports_escalated_idx ON moderation_reports(status, severity DESC, created_at) WHERE status IN ('open','escalated');

CREATE TABLE moderation_logs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id         uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  media_id         uuid,
  actor_type       text NOT NULL CHECK (actor_type IN ('user','staff','system','guest')),
  actor_id         uuid,
  action           text NOT NULL,
  from_state       text,
  to_state         text,
  reason           text,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX moderation_logs_event_idx ON moderation_logs(event_id, created_at DESC);

-- ---------------------------------------------------------------- payments / entitlements
CREATE TABLE payment_orders (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_ref        text NOT NULL UNIQUE,               -- opaque merchant reference sent to the provider (tx_ref)
  event_id         uuid NOT NULL REFERENCES events(id),
  user_id          uuid NOT NULL REFERENCES users(id),
  plan_id          uuid NOT NULL REFERENCES plans(id),
  amount_etb       numeric(12,2) NOT NULL CHECK (amount_etb > 0),
  currency         text NOT NULL DEFAULT 'ETB' CHECK (currency = 'ETB'),
  provider         text NOT NULL,
  provider_reference text,
  checkout_url     text,
  state            text NOT NULL DEFAULT 'created'
                   CHECK (state IN ('created','pending','paid','failed','cancelled','expired','mismatch','refund_requested','refunded','refund_failed')),
  idempotency_key  text,
  verified_at      timestamptz,
  verification_summary jsonb,                           -- minimal provider status snapshot, no credentials
  expires_at       timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX payment_orders_idem_uq ON payment_orders(user_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX payment_orders_provider_ref_uq ON payment_orders(provider, provider_reference) WHERE provider_reference IS NOT NULL;
CREATE INDEX payment_orders_event_idx ON payment_orders(event_id);
CREATE INDEX payment_orders_state_idx ON payment_orders(state, created_at DESC);

CREATE TABLE payment_callbacks (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider         text NOT NULL,
  order_ref        text,
  dedupe_key       text NOT NULL UNIQUE,                -- hash of provider + ref + status: duplicates are no-ops
  signature_valid  boolean NOT NULL,
  payload          jsonb NOT NULL DEFAULT '{}'::jsonb,
  outcome          text,                                -- activated | duplicate | rejected_signature | verification_failed | mismatch | ignored | provider_outage
  received_at      timestamptz NOT NULL DEFAULT now(),
  processed_at     timestamptz
);
CREATE INDEX payment_callbacks_order_idx ON payment_callbacks(order_ref, received_at DESC);

CREATE TABLE entitlements (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id         uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  plan_id          uuid NOT NULL REFERENCES plans(id),
  source           text NOT NULL CHECK (source IN ('payment','free_trial','staff_grant')),
  order_id         uuid REFERENCES payment_orders(id),
  storage_bytes    bigint NOT NULL,
  max_media        int NOT NULL,
  retention_days   int NOT NULL,
  original_storage boolean NOT NULL,
  allow_original_export boolean NOT NULL,
  max_collaborators int NOT NULL,
  photographer_seats int NOT NULL,
  concurrent_uploads int NOT NULL,
  branding         boolean NOT NULL,
  watermark        boolean NOT NULL,
  state            text NOT NULL DEFAULT 'active' CHECK (state IN ('active','revoked')),
  effective_from   timestamptz NOT NULL DEFAULT now(),
  effective_to     timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX entitlements_order_uq ON entitlements(order_id) WHERE order_id IS NOT NULL;
CREATE INDEX entitlements_event_idx ON entitlements(event_id) WHERE state = 'active';

CREATE TABLE refunds (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id         uuid NOT NULL REFERENCES payment_orders(id),
  amount_etb       numeric(12,2) NOT NULL CHECK (amount_etb > 0),
  reason           text NOT NULL,
  state            text NOT NULL DEFAULT 'requested' CHECK (state IN ('requested','processing','succeeded','failed','rejected')),
  provider_refund_ref text,
  requested_by     uuid REFERENCES users(id),
  decided_by       uuid REFERENCES users(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX refunds_order_idx ON refunds(order_id);

CREATE SEQUENCE invoice_number_seq START 1;
CREATE TABLE invoices (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number           text NOT NULL UNIQUE,
  order_id         uuid NOT NULL UNIQUE REFERENCES payment_orders(id),
  user_id          uuid NOT NULL REFERENCES users(id),
  organization_id  uuid REFERENCES organizations(id),
  amount_etb       numeric(12,2) NOT NULL,
  tax_rate         numeric(6,4),                        -- NULL until accountant validates VAT/TOT treatment
  tax_amount_etb   numeric(12,2),
  tax_status       text NOT NULL DEFAULT 'unvalidated' CHECK (tax_status IN ('unvalidated','validated')),
  line_items       jsonb NOT NULL DEFAULT '[]'::jsonb,
  status           text NOT NULL DEFAULT 'issued' CHECK (status IN ('issued','void','credited')),
  issued_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX invoices_user_idx ON invoices(user_id, issued_at DESC);

CREATE TABLE reconciliation_runs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider         text NOT NULL,
  run_date         date NOT NULL,
  checked          int NOT NULL DEFAULT 0,
  matched          int NOT NULL DEFAULT 0,
  mismatched       int NOT NULL DEFAULT 0,
  outage           boolean NOT NULL DEFAULT false,
  report           jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, run_date)
);

-- Sandbox gateway state (non-production only; the sandbox provider reads/writes this).
CREATE TABLE sandbox_transactions (
  tx_ref           text PRIMARY KEY,
  amount_etb       numeric(12,2) NOT NULL,
  status           text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','success','failed','cancelled')),
  created_at       timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- notifications
CREATE TABLE notifications (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recipient_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  recipient_session_id uuid REFERENCES guest_sessions(id) ON DELETE SET NULL,
  recipient_phone_enc text,                             -- needed to deliver; erased once sent
  channel          text NOT NULL CHECK (channel IN ('sms','email','in_app','push')),
  template         text NOT NULL,
  locale           text NOT NULL DEFAULT 'en',
  params           jsonb NOT NULL DEFAULT '{}'::jsonb,  -- never contains OTP codes
  state            text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','sent','delivered','failed')),
  provider         text,
  provider_reference text,
  attempts         int NOT NULL DEFAULT 0,
  error            text,
  event_id         uuid REFERENCES events(id) ON DELETE SET NULL,
  read_at          timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  sent_at          timestamptz
);
CREATE INDEX notifications_user_idx ON notifications(recipient_user_id, created_at DESC);
CREATE INDEX notifications_state_idx ON notifications(state, created_at);

-- ---------------------------------------------------------------- audit (immutable, hash-chained)
CREATE TABLE audit_events (
  seq              bigserial PRIMARY KEY,
  id               uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  actor_type       text NOT NULL CHECK (actor_type IN ('user','staff','guest','system','provider')),
  actor_id         uuid,
  actor_role       text,
  action           text NOT NULL,
  resource_type    text NOT NULL,
  resource_id      text,
  event_id         uuid,
  reason           text,
  before_summary   jsonb,
  after_summary    jsonb,
  ip               inet,
  user_agent       text,
  device           text,
  request_id       text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  prev_hash        text,
  hash             text NOT NULL
);
CREATE INDEX audit_actor_idx ON audit_events(actor_id, created_at DESC);
CREATE INDEX audit_resource_idx ON audit_events(resource_type, resource_id);
CREATE INDEX audit_event_idx ON audit_events(event_id, created_at DESC);
CREATE INDEX audit_action_idx ON audit_events(action, created_at DESC);

CREATE FUNCTION audit_events_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only (% blocked)', TG_OP USING ERRCODE = '42501';
END $$;
CREATE TRIGGER audit_events_no_update BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION audit_events_immutable();

-- Elevated (support/admin) access to private media: reason + separate approver + expiry.
CREATE TABLE media_access_grants (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id         uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  media_id         uuid REFERENCES media(id) ON DELETE CASCADE,   -- NULL = whole event
  requested_by     uuid NOT NULL REFERENCES users(id),
  reason           text NOT NULL CHECK (char_length(reason) >= 10),
  ticket_ref       text,
  state            text NOT NULL DEFAULT 'requested' CHECK (state IN ('requested','approved','denied','expired','revoked')),
  approved_by      uuid REFERENCES users(id),
  decided_at       timestamptz,
  expires_at       timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX media_access_grants_idx ON media_access_grants(requested_by, state);

CREATE TABLE support_tickets (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ref              text NOT NULL UNIQUE,
  user_id          uuid REFERENCES users(id) ON DELETE SET NULL,
  event_id         uuid REFERENCES events(id) ON DELETE SET NULL,
  category         text NOT NULL DEFAULT 'general' CHECK (category IN ('general','payment','refund','access','abuse','privacy')),
  subject          text NOT NULL,
  body             text NOT NULL,
  status           text NOT NULL DEFAULT 'open' CHECK (status IN ('open','pending','resolved','closed')),
  assigned_to      uuid REFERENCES users(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX support_tickets_user_idx ON support_tickets(user_id, created_at DESC);

-- ---------------------------------------------------------------- privacy / compliance
CREATE TABLE policy_documents (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind             text NOT NULL CHECK (kind IN ('guest_notice','privacy_policy','terms','host_terms','content_policy','removal_policy','refund_policy')),
  version          text NOT NULL,
  locale           text NOT NULL CHECK (locale IN ('en','am')),
  title            text NOT NULL,
  body             text NOT NULL,
  legal_status     text NOT NULL DEFAULT 'draft_pending_legal_review' CHECK (legal_status IN ('draft_pending_legal_review','approved')),
  effective_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (kind, version, locale)
);

CREATE TABLE consent_records (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_type     text NOT NULL CHECK (subject_type IN ('guest_session','user')),
  guest_session_id uuid REFERENCES guest_sessions(id) ON DELETE SET NULL,
  user_id          uuid REFERENCES users(id) ON DELETE SET NULL,
  event_id         uuid REFERENCES events(id) ON DELETE SET NULL,
  purpose          text NOT NULL,                       -- e.g. event_photo_upload, phone_verification
  policy_kind      text NOT NULL,
  policy_version   text NOT NULL,
  locale           text NOT NULL,
  action           text NOT NULL CHECK (action IN ('granted','withdrawn')),
  withdrawn_at     timestamptz,
  ip_hash          text,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX consent_session_idx ON consent_records(guest_session_id);
CREATE INDEX consent_event_idx ON consent_records(event_id, created_at DESC);

CREATE TABLE rights_requests (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ref              text NOT NULL UNIQUE,                -- shown to the requester
  access_token_hash text NOT NULL,                      -- requester uses this to inspect status
  type             text NOT NULL CHECK (type IN ('access','erasure','removal','objection','restriction','consent_withdrawal')),
  requester_kind   text NOT NULL CHECK (requester_kind IN ('guest','host','other')),
  contact_enc      text,                                -- optional contact (encrypted), minimal
  event_id         uuid REFERENCES events(id) ON DELETE SET NULL,
  media_id         uuid REFERENCES media(id) ON DELETE SET NULL,
  guest_session_id uuid REFERENCES guest_sessions(id) ON DELETE SET NULL,
  user_id          uuid REFERENCES users(id) ON DELETE SET NULL,
  details          text CHECK (details IS NULL OR char_length(details) <= 2000),
  state            text NOT NULL DEFAULT 'received'
                   CHECK (state IN ('received','identity_verification','in_progress','completed','rejected')),
  due_at           timestamptz NOT NULL,                -- SLA configurable (legal decision, see docs/LEGAL_FLAGS.md)
  assigned_to      uuid REFERENCES users(id),
  outcome_note     text,
  evidence         jsonb NOT NULL DEFAULT '[]'::jsonb,  -- append-only completion evidence
  created_at       timestamptz NOT NULL DEFAULT now(),
  completed_at     timestamptz
);
CREATE INDEX rights_requests_state_idx ON rights_requests(state, due_at);

CREATE TABLE deletion_jobs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  resource_type    text NOT NULL CHECK (resource_type IN ('event','media','user_data','guest_session')),
  resource_id      uuid NOT NULL,
  event_id         uuid,
  trigger          text NOT NULL CHECK (trigger IN ('host_request','retention_expiry','rights_request','staff','guest_self')),
  scheduled_at     timestamptz NOT NULL,
  status           text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','completed','failed','cancelled','held')),
  legal_hold       boolean NOT NULL DEFAULT false,
  attempts         int NOT NULL DEFAULT 0,
  started_at       timestamptz,
  completed_at     timestamptz,
  evidence         jsonb NOT NULL DEFAULT '{}'::jsonb,  -- counts of purged objects/rows, no content
  requested_by     uuid,
  rights_request_id uuid REFERENCES rights_requests(id),
  backup_purge_by  timestamptz,                         -- when backups containing the data must have expired
  last_error       text,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX deletion_jobs_due_idx ON deletion_jobs(scheduled_at) WHERE status IN ('pending','held');
CREATE UNIQUE INDEX deletion_jobs_active_uq ON deletion_jobs(resource_type, resource_id) WHERE status IN ('pending','running','held');

CREATE TABLE legal_holds (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id         uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  reason           text NOT NULL,
  placed_by        uuid NOT NULL REFERENCES users(id),
  placed_at        timestamptz NOT NULL DEFAULT now(),
  released_by      uuid REFERENCES users(id),
  released_at      timestamptz
);
CREATE INDEX legal_holds_event_idx ON legal_holds(event_id) WHERE released_at IS NULL;

CREATE TABLE incidents (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ref              text NOT NULL UNIQUE,
  kind             text NOT NULL CHECK (kind IN ('security','personal_data_breach','abuse','operational','criminal_content')),
  severity         text NOT NULL CHECK (severity IN ('low','medium','high','critical')),
  title            text NOT NULL,
  description      text,
  event_id         uuid REFERENCES events(id) ON DELETE SET NULL,
  discovered_at    timestamptz NOT NULL,                -- explicit "time discovered" - starts the 72h clock
  regulator_notify_due_at timestamptz,
  regulator_notified_at timestamptz,
  subjects_notify_due_at timestamptz,
  subjects_notified_at timestamptz,
  data_categories  text[] NOT NULL DEFAULT '{}',
  approx_subjects  int,
  approx_records   int,
  state            text NOT NULL DEFAULT 'open' CHECK (state IN ('open','contained','notified','resolved','closed')),
  commander_id     uuid REFERENCES users(id),
  postmortem       text,
  created_by       uuid REFERENCES users(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX incidents_state_idx ON incidents(state, discovered_at DESC);

CREATE TABLE incident_log (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_id      uuid NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  actor_id         uuid REFERENCES users(id),
  entry            text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE vendors (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name             text NOT NULL UNIQUE,
  purpose          text NOT NULL,
  data_categories  text[] NOT NULL DEFAULT '{}',
  data_location    text NOT NULL,                       -- where processed/stored
  outside_ethiopia boolean NOT NULL DEFAULT false,      -- requires transfer assessment before enabling
  subprocessors    text,
  retention        text,
  dpa_signed       boolean NOT NULL DEFAULT false,
  transfer_assessment_ref text,
  breach_contact   text,
  status           text NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','active','suspended','retired')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- exports / ops
CREATE TABLE exports (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id         uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  requested_by     uuid NOT NULL REFERENCES users(id),
  scope            text NOT NULL CHECK (scope IN ('full','folder','selected')),
  folder_id        uuid REFERENCES event_folders(id) ON DELETE SET NULL,
  media_ids        uuid[],
  variant          text NOT NULL DEFAULT 'optimized' CHECK (variant IN ('optimized','original')),
  state            text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','processing','ready','failed','expired')),
  object_key       text,
  bytes            bigint,
  item_count       int,
  error            text,
  expires_at       timestamptz,
  idempotency_key  text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  completed_at     timestamptz
);
CREATE INDEX exports_event_idx ON exports(event_id, created_at DESC);
CREATE UNIQUE INDEX exports_idem_uq ON exports(requested_by, idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE TABLE idempotency_keys (
  scope            text NOT NULL,
  key              text NOT NULL,
  request_hash     text NOT NULL,
  status_code      int,
  response         jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scope, key)
);
CREATE INDEX idempotency_created_idx ON idempotency_keys(created_at);

CREATE TABLE system_settings (
  key              text PRIMARY KEY,
  value            jsonb NOT NULL,
  description      text,
  updated_by       uuid,
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE analytics_counters (
  event_id         uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  day              date NOT NULL,
  metric           text NOT NULL,
  n                bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (event_id, day, metric)
);
CREATE TABLE analytics_session_steps (
  session_id       uuid NOT NULL REFERENCES guest_sessions(id) ON DELETE CASCADE,
  event_id         uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  step             text NOT NULL,
  first_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, step)
);
CREATE INDEX analytics_steps_event_idx ON analytics_session_steps(event_id, step);

CREATE TABLE storage_scans (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind             text NOT NULL CHECK (kind IN ('orphan_scan','stale_cleanup')),
  started_at       timestamptz NOT NULL DEFAULT now(),
  finished_at      timestamptz,
  objects_checked  int NOT NULL DEFAULT 0,
  orphans_found    int NOT NULL DEFAULT 0,
  orphans_removed  int NOT NULL DEFAULT 0,
  report           jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE backup_runs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind             text NOT NULL CHECK (kind IN ('database','objects','wal')),
  status           text NOT NULL CHECK (status IN ('running','succeeded','failed')),
  location_label   text NOT NULL,                       -- must be an Ethiopian site label
  bytes            bigint,
  encrypted        boolean NOT NULL DEFAULT true,
  started_at       timestamptz NOT NULL DEFAULT now(),
  finished_at      timestamptz,
  verified_at      timestamptz,                         -- restore test timestamp
  expires_at       timestamptz,
  note             text
);
