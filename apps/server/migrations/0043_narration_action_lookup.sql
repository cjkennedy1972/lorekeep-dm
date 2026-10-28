CREATE INDEX events_round_action_owner_seq_idx
  ON events (session_id, (payload->'submission'->>'accountId'), seq DESC)
  WHERE type IN ('RoundActionAccepted','RoundActionEdited');
