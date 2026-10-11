ALTER TABLE sessions
 ADD COLUMN moderation_verified boolean NOT NULL DEFAULT false,
 ADD COLUMN content_tier text NOT NULL DEFAULT 'standard' CHECK (content_tier IN ('family','standard','mature'));
