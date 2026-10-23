ALTER TABLE seat_resume_tokens
  ADD COLUMN active_socket_id uuid,
  ADD COLUMN heartbeat_at timestamptz,
  ADD CONSTRAINT seat_resume_socket_heartbeat_pair
    CHECK ((active_socket_id IS NULL) = (heartbeat_at IS NULL));

CREATE FUNCTION expire_seat_resume_token_on_revocation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.type = 'SeatRevoked' THEN
    DELETE FROM seat_resume_tokens
      WHERE session_id = NEW.session_id AND seat_id = (NEW.payload->>'seatId')::uuid;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER events_expire_seat_resume_token
AFTER INSERT ON events
FOR EACH ROW EXECUTE FUNCTION expire_seat_resume_token_on_revocation();
