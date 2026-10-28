-- Plain CREATE INDEX builds under a lock that blocks writes for the duration of
-- the build. This follows the plain-index precedent in 0018_seat_joined_index;
-- use a non-transactional CREATE INDEX CONCURRENTLY migration if this table's
-- production size makes the write pause unacceptable.
CREATE INDEX events_round_action_owner_seq_idx
  ON events (session_id, (payload->'submission'->>'accountId'), seq DESC)
  WHERE type IN ('RoundActionAccepted','RoundActionEdited');
