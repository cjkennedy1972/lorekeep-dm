export const up = (pgm) =>
  pgm.sql(`
    CREATE INDEX events_seat_joined_account_idx
      ON events ((payload->>'accountId'), session_id)
      WHERE type = 'SeatJoined';
  `);
export const down = (pgm) =>
  pgm.sql('DROP INDEX events_seat_joined_account_idx;');
