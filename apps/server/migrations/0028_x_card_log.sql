CREATE TABLE x_card_log (
 id bigserial PRIMARY KEY,
 session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
 seat_id uuid NOT NULL,
 written_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL,
 CHECK (expires_at = written_at + interval '30 days')
);
CREATE INDEX x_card_log_expiry_idx ON x_card_log(expires_at);
