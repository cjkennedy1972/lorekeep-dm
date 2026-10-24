-- Preserve initialized tokens; missing rows get an unguessable placeholder hash,
-- requiring host-approved recovery before a device can establish its token.
INSERT INTO seat_resume_tokens (session_id, seat_id, token_hash)
SELECT DISTINCT ON (j.session_id, j.payload->>'seatId')
       j.session_id,
       (j.payload->>'seatId')::uuid,
       replace(gen_random_uuid()::text, '-', '')
  FROM events j
 WHERE j.type = 'SeatJoined'
   AND j.payload ? 'seatId'
   AND NOT EXISTS (
     SELECT 1 FROM events r
      WHERE r.session_id=j.session_id AND r.type='SeatRevoked'
        AND r.payload->>'seatId'=j.payload->>'seatId' AND r.seq>j.seq
   )
 ORDER BY j.session_id, j.payload->>'seatId', j.seq DESC
ON CONFLICT (session_id, seat_id) DO NOTHING;

CREATE FUNCTION initialize_seat_resume_token() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.type = 'SeatJoined' AND NEW.payload ? 'seatId' THEN
    INSERT INTO seat_resume_tokens (session_id, seat_id, token_hash)
    VALUES (
      NEW.session_id,
      (NEW.payload->>'seatId')::uuid,
      replace(gen_random_uuid()::text, '-', '')
    )
    ON CONFLICT (session_id, seat_id) DO NOTHING;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER events_initialize_seat_resume_token
AFTER INSERT ON events
FOR EACH ROW EXECUTE FUNCTION initialize_seat_resume_token();
