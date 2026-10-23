CREATE TABLE seat_resume_tokens (
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  seat_id uuid NOT NULL,
  token_hash text NOT NULL,
  rotated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, seat_id)
);
