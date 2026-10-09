ALTER TABLE sessions ADD COLUMN mode text NOT NULL DEFAULT 'party' CHECK (mode IN ('solo','party'));
ALTER TABLE sessions ADD COLUMN adventure_id text;
ALTER TABLE sessions ADD COLUMN difficulty text NOT NULL DEFAULT 'moderate' CHECK (difficulty IN ('easy','moderate','hard'));
ALTER TABLE sessions ADD COLUMN catalog_version text;
ALTER TABLE sessions ADD COLUMN premise text;
ALTER TABLE sessions ADD COLUMN character_id text;
ALTER TABLE sessions ADD COLUMN character jsonb;
CREATE INDEX sessions_owner_activity_idx ON sessions(owner_account_id, last_active_at DESC);
