CREATE INDEX events_seat_joined_account_idx
  ON events ((payload->>'accountId'), session_id)
  WHERE type = 'SeatJoined';
