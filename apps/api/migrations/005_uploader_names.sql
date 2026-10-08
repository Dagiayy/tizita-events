-- Gallery "by sender" view: the host decides whether guests may see who uploaded each photo.
-- Only the display name the sender chose on the join screen is ever shown (never phone numbers or ids).
ALTER TABLE events ADD COLUMN IF NOT EXISTS show_uploader_names boolean NOT NULL DEFAULT true;
