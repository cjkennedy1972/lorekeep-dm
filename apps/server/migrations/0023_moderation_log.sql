CREATE TABLE moderation_log (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 written_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL,
 surface text NOT NULL CHECK (surface IN ('player-action','clarification','character','table-name','room-name','display-name')),
 account_id uuid,
 session_id uuid,
 category text NOT NULL CHECK (category IN ('none','violence','language','sexual','minor_sexual','hate','self_harm','lines_veils','other')),
 source text NOT NULL CHECK (source IN ('hardfloor','denylist','judge','failclosed')),
 fail_closed_row text CHECK (fail_closed_row IN ('hard-floor','tier')),
 CHECK ((source = 'failclosed') = (fail_closed_row IS NOT NULL)),
 CHECK (expires_at = written_at + interval '30 days')
);
CREATE INDEX moderation_log_expiry_idx ON moderation_log(expires_at);
