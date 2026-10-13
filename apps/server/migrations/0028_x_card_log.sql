CREATE TABLE x_card_log (
 id bigserial PRIMARY KEY,
 session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
 seat_id uuid NOT NULL,
 written_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL,
 CHECK (expires_at = written_at + interval '30 days')
);
CREATE INDEX x_card_log_expiry_idx ON x_card_log(expires_at);

-- Preserve any seat link already recorded by an earlier X-card build only for
-- the remainder of its original 30-day window, then remove it from replay data.
INSERT INTO x_card_log(session_id,seat_id,written_at,expires_at)
SELECT session_id,(payload->>'seatId')::uuid,ts,ts + interval '30 days'
FROM events
WHERE type='SafetyFlag'
  AND jsonb_typeof(payload->'seatId')='string'
  AND payload->>'seatId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

-- SafetyFlag is a log-class event. Anonymized event rows retain their normal
-- state-replay role for only the same 30-day window, then the logs sweeper purges them.
DO $$
DECLARE prior text;
BEGIN
  prior := current_setting('lorekeep.redacting_event', true);
  PERFORM set_config('lorekeep.redacting_event', 'on', true);
  UPDATE events
  SET payload = CASE
        WHEN payload ? 'seatId' THEN jsonb_build_object('kind', COALESCE(payload->>'kind','x-card'))
        ELSE payload
      END,
      expires_at = COALESCE(expires_at, ts + interval '30 days')
  WHERE type='SafetyFlag';
  PERFORM set_config('lorekeep.redacting_event', COALESCE(prior, 'off'), true);
END $$;
