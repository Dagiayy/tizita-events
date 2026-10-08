-- 003_caption_rules_and_templates.sql
-- Spec 6.2 "profanity/keyword rules for captions if captions exist" and 6.1 "notification templates, SMS sender IDs".

ALTER TABLE events ADD COLUMN caption_keywords text[] NOT NULL DEFAULT '{}';
ALTER TABLE media ADD COLUMN caption_flagged boolean NOT NULL DEFAULT false;

INSERT INTO system_settings (key, value, description) VALUES
 ('moderation.caption_keywords', '[]'::jsonb, 'Platform-wide blocked caption keywords (case-insensitive substring match, Ethiopic supported). Matching captions are dropped and the photo is held for host review.'),
 ('notification.templates', '{}'::jsonb, 'Optional SMS template overrides: {"template_name": {"en": "...", "am": "..."}}. OTP templates must keep the {code} and {minutes} placeholders.')
ON CONFLICT (key) DO NOTHING;
