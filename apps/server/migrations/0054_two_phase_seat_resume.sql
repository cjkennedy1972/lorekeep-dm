ALTER TABLE seat_resume_tokens
  ADD COLUMN pending_token_hash text,
  ADD COLUMN pending_rotation_id uuid,
  ADD COLUMN pending_socket_id uuid,
  ADD COLUMN pending_expires_at timestamptz,
  ADD COLUMN pending_started_at timestamptz,
  ADD COLUMN pending_owner_recovery boolean NOT NULL DEFAULT false,
  ADD COLUMN last_activated_rotation_id uuid,
  ADD COLUMN last_activated_socket_id uuid,
  ADD COLUMN last_activated_at timestamptz,
  ADD COLUMN rotation_window_started_at timestamptz,
  ADD COLUMN rotation_starts_in_window smallint NOT NULL DEFAULT 0,
  ADD CONSTRAINT seat_resume_pending_tuple CHECK (
    (pending_token_hash IS NULL AND pending_rotation_id IS NULL AND pending_socket_id IS NULL
      AND pending_expires_at IS NULL AND pending_started_at IS NULL AND NOT pending_owner_recovery)
    OR
    (pending_token_hash IS NOT NULL AND pending_rotation_id IS NOT NULL AND pending_socket_id IS NOT NULL
      AND pending_expires_at IS NOT NULL AND pending_started_at IS NOT NULL)
  ),
  ADD CONSTRAINT seat_resume_last_activated_tuple CHECK (
    (last_activated_rotation_id IS NULL AND last_activated_socket_id IS NULL AND last_activated_at IS NULL)
    OR
    (last_activated_rotation_id IS NOT NULL AND last_activated_socket_id IS NOT NULL AND last_activated_at IS NOT NULL)
  ),
  ADD CONSTRAINT seat_resume_rotation_window_pair CHECK (
    (rotation_window_started_at IS NULL) = (rotation_starts_in_window = 0)
  ),
  ADD CONSTRAINT seat_resume_rotation_starts_cap CHECK (rotation_starts_in_window BETWEEN 0 AND 6);

CREATE INDEX seat_resume_pending_expiry_idx
  ON seat_resume_tokens (pending_expires_at)
  WHERE pending_token_hash IS NOT NULL;
