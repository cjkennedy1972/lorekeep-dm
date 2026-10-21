ALTER TABLE moderation_log DROP CONSTRAINT moderation_log_surface_check;
ALTER TABLE moderation_log
  ADD CONSTRAINT moderation_log_surface_check
  CHECK (surface IN ('player-action','clarification','chat','character','table-name','room-name','display-name','report-reason'));
ALTER TABLE moderation_log DROP CONSTRAINT moderation_log_source_check;
ALTER TABLE moderation_log
  ADD CONSTRAINT moderation_log_source_check
  CHECK (source IN ('hardfloor','denylist','judge','failclosed','rate-limit'));

CREATE TABLE chat_mutes (
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  seat_id uuid NOT NULL,
  muted_until timestamptz,
  source text NOT NULL CHECK (source IN ('automatic','host')),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES accounts(id) ON DELETE SET NULL,
  PRIMARY KEY (session_id, seat_id)
);
CREATE INDEX chat_mutes_expiry_idx ON chat_mutes(muted_until) WHERE muted_until IS NOT NULL;
