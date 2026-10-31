CREATE TABLE seat_streams (
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  seat_id uuid NOT NULL,
  binding_epoch bigint NOT NULL CHECK (binding_epoch > 0),
  generation text NOT NULL CHECK (generation ~ '^[A-Za-z0-9_-]{22}$'),
  cursor bigint NOT NULL DEFAULT 0 CHECK (cursor >= 0),
  PRIMARY KEY (session_id, seat_id)
);
