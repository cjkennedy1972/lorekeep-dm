export const up = (pgm) =>
  pgm.sql(`
    CREATE INDEX events_round_action_owner_seq_idx
      ON events (session_id, (payload->'submission'->>'accountId'), seq DESC)
      WHERE type IN ('RoundActionAccepted','RoundActionEdited');
  `);
export const down = (pgm) =>
  pgm.sql('DROP INDEX events_round_action_owner_seq_idx;');
