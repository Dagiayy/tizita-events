-- 002_reference_data.sql
-- Reference data required for the normal workflow to run without manual DB intervention.
-- PRICES AND LIMITS ARE PLACEHOLDERS: they are business decisions (spec D58-D60) editable from
-- the admin plan manager. Policy texts are DRAFTS and flagged for Ethiopian legal review.

INSERT INTO plans (code, kind, name_en, name_am, description_en, description_am, price_etb, storage_bytes, max_media,
                   retention_days, original_storage, allow_original_export, max_collaborators, photographer_seats,
                   concurrent_uploads, branding, watermark, is_trial, sort_order)
VALUES
 ('trial', 'package', 'Trial Event', 'የሙከራ ዝግጅት',
  'One small event to try the service. Limited photos and storage.',
  'አገልግሎቱን ለመሞከር አንድ ትንሽ ዝግጅት። የፎቶ እና የማከማቻ ገደብ አለው።',
  0, 524288000, 100, 30, false, false, 1, 0, 2, false, false, true, 0),
 ('single_event', 'package', 'Single Event', 'ነጠላ ዝግጅት',
  'One event with a defined upload window, standard gallery and export.',
  'የተወሰነ የመጫኛ ጊዜ፣ መደበኛ ማዕከለ ስዕል እና ማውረጃ ያለው አንድ ዝግጅት።',
  1200, 5368709120, 1500, 180, false, false, 2, 0, 4, false, false, false, 10),
 ('event_plus', 'package', 'Event Plus', 'ዝግጅት ፕላስ',
  'More storage, longer retention, original-quality storage and more collaborators.',
  'ተጨማሪ ማከማቻ፣ ረዘም ያለ ማቆያ፣ ዋናው ጥራት ያለው ማከማቻ እና ተጨማሪ ተባባሪዎች።',
  2800, 21474836480, 6000, 365, true, true, 5, 1, 8, true, true, false, 20),
 ('professional', 'package', 'Professional / Photographer', 'ፕሮፌሽናል / ፎቶ አንሺ',
  'Higher storage, photographer seats, batch upload and client delivery.',
  'ከፍተኛ ማከማቻ፣ የፎቶ አንሺ መቀመጫዎች፣ ብዙ ፎቶዎችን መጫን እና ለደንበኛ ማስረከብ።',
  6500, 107374182400, 30000, 365, true, true, 10, 5, 12, true, true, false, 30),
 ('addon_storage_10gb', 'addon', 'Extra storage 10 GB', 'ተጨማሪ ማከማቻ 10 ጊጋባይት',
  'Explicit storage upgrade. We never bill overages silently.',
  'በግልጽ የሚገዛ የማከማቻ ማሻሻያ። ያለ ማሳወቅ ተጨማሪ ክፍያ አንጠይቅም።',
  400, 10737418240, 3000, 0, false, false, 0, 0, 0, false, false, false, 40),
 ('addon_retention_90d', 'addon', 'Extended retention +90 days', 'ተጨማሪ ማቆያ +90 ቀናት',
  'Keep the gallery online 90 days longer after the event closes.',
  'ዝግጅቱ ከተዘጋ በኋላ ማዕከለ ስዕሉን 90 ቀናት ረዘም ብሎ ያቆያል።',
  300, 0, 0, 90, false, false, 0, 0, 0, false, false, false, 50);

INSERT INTO system_settings (key, value, description) VALUES
 ('media.max_bytes',               to_jsonb(15728640),  'Maximum accepted photo size in bytes (spec 8.2: 15 MB)'),
 ('media.allowed_mime',            '["image/jpeg","image/png","image/webp","image/heic","image/heif"]', 'Allowed MIME types (photo-first MVP)'),
 ('maintenance.mode',              'false'::jsonb,       'When true all non-admin write endpoints return 503'),
 ('retention.default_days',        to_jsonb(180),        'Default online retention after closure (spec D31) - LEGAL VALIDATION PENDING'),
 ('retention.readonly_to_archive_days', to_jsonb(30),    'Days in read-only before automatic archive'),
 ('deletion.grace_days',           to_jsonb(14),         'Grace period between deletion request and purge (spec D32: 7-30)'),
 ('backup.retention_days',         to_jsonb(35),         'Backup expiry so deleted media does not persist indefinitely (spec D33)'),
 ('rights.sla_days',               to_jsonb(30),         'Target days to complete a data-subject request - LEGAL VALIDATION PENDING'),
 ('sms.sender_id',                 '"EventPhoto"'::jsonb,'Sender ID used by the SMS provider'),
 ('guest.max_uploads_per_session', to_jsonb(100),        'Per-session upload cap'),
 ('tax.vat_rate',                  'null'::jsonb,        'VAT/TOT rate. NULL until the accountant validates treatment (spec 12.3, D57)'),
 ('quota.alert_thresholds',        '[70,85,95,100]'::jsonb, 'Storage quota alert percentages (spec 16)');

-- Guest event notice (concise, shown before upload; consent is a separate active action).
INSERT INTO policy_documents (kind, version, locale, title, body) VALUES
 ('guest_notice', '2026-10-draft', 'en', 'Event photo notice',
  'Photos you upload are shared with the event host and, once approved, with other guests of this event. Photos can show people''s faces and other personal information, so only upload photos you have the right to share. We do not use facial recognition. You can report any photo or ask for its removal at any time. Photos are stored in Ethiopia and deleted when the event''s retention period ends.'),
 ('guest_notice', '2026-10-draft', 'am', 'የዝግጅት ፎቶ ማሳወቂያ',
  'የሚያስገቡት ፎቶዎች ለዝግጅቱ አስተናጋጅ እንዲሁም ከተፈቀዱ በኋላ ለሌሎች የዝግጅቱ እንግዶች ይታያሉ። ፎቶዎች የሰዎችን ፊት እና ሌሎች የግል መረጃዎችን ሊያሳዩ ስለሚችሉ ለማጋራት መብት ያለዎትን ፎቶዎች ብቻ ያስገቡ። የፊት ለይቶ ማወቂያ አንጠቀምም። ማንኛውንም ፎቶ በማንኛውም ጊዜ ሪፖርት ማድረግ ወይም እንዲወገድ መጠየቅ ይችላሉ። ፎቶዎች በኢትዮጵያ ውስጥ ይቀመጣሉ፤ የዝግጅቱ የማቆያ ጊዜ ሲያበቃ ይሰረዛሉ።'),
 ('privacy_policy', '2026-10-draft', 'en', 'Privacy policy (draft)', 'DRAFT - requires validation by Ethiopian counsel before launch.'),
 ('privacy_policy', '2026-10-draft', 'am', 'የግላዊነት ፖሊሲ (ረቂቅ)', 'ረቂቅ - ከመጀመሩ በፊት በኢትዮጵያ ጠበቃ መረጋገጥ አለበት።'),
 ('terms', '2026-10-draft', 'en', 'Terms of service (draft)', 'DRAFT - requires validation by Ethiopian counsel before launch.'),
 ('terms', '2026-10-draft', 'am', 'የአገልግሎት ውሎች (ረቂቅ)', 'ረቂቅ - ከመጀመሩ በፊት በኢትዮጵያ ጠበቃ መረጋገጥ አለበት።'),
 ('host_terms', '2026-10-draft', 'en', 'Event host terms and data processing addendum (draft)', 'DRAFT - controller/processor allocation requires legal review (decision D54).'),
 ('host_terms', '2026-10-draft', 'am', 'የዝግጅት አስተናጋጅ ውሎች (ረቂቅ)', 'ረቂቅ - የውሳኔ D54 ህጋዊ ግምገማ ያስፈልገዋል።');

-- Vendor / processor register seed (spec 9.4): every external processor must be an explicit record.
INSERT INTO vendors (name, purpose, data_categories, data_location, outside_ethiopia, subprocessors, retention, status) VALUES
 ('Ethiopia-hosted infrastructure provider (to be selected: Ethio telecom / Wingu)', 'Compute, PostgreSQL, Redis, object storage, backups', ARRAY['host phone','event photos','guest session metadata','payment references'], 'Ethiopia', false, 'TBD at contract', 'Per backup policy', 'planned'),
 ('Local SMS / A2P provider (primary)', 'OTP and transactional SMS', ARRAY['phone number','message text'], 'Ethiopia (verify)', false, 'Ethio telecom / Safaricom Ethiopia routes', 'Provider delivery logs - verify', 'planned'),
 ('Local SMS / A2P provider (fallback)', 'Fallback OTP route', ARRAY['phone number','message text'], 'Ethiopia (verify)', false, 'TBD', 'Provider delivery logs - verify', 'planned'),
 ('Chapa (payment gateway)', 'ETB package payments (telebirr, bank, M-Pesa)', ARRAY['payer name/phone as entered on provider page','transaction reference','amount'], 'Ethiopia (verify with provider)', false, 'telebirr / banks / M-Pesa', 'Per provider terms', 'planned'),
 ('Direct telebirr (Ethio telecom)', 'Optional direct payment integration', ARRAY['transaction reference','amount'], 'Ethiopia', false, '-', 'Per provider terms', 'planned');
