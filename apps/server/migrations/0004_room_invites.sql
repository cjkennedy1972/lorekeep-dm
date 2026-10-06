ALTER TABLE sessions ADD COLUMN name text NOT NULL DEFAULT 'Table';
-- sha256 hex of the invite secret; NULL means no live invite (revoked or never issued). The secret itself is never stored.
ALTER TABLE sessions ADD COLUMN invite_hash text;
CREATE UNIQUE INDEX sessions_invite_hash_key ON sessions (invite_hash) WHERE invite_hash IS NOT NULL;
