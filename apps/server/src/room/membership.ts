/**
 * SQL predicate: the account currently holds a seat in session `s` (alias `s`). A SeatJoined
 * counts unless a later SeatRevoked for the same account exists; a rejoin after revocation
 * is a newer SeatJoined and counts again. `accountParam` is a SQL parameter placeholder.
 */
export function currentMemberSql(
  accountParam: string,
  sessionAlias = 's',
): string {
  return `EXISTS (SELECT 1 FROM events j WHERE j.session_id=${sessionAlias}.id AND j.type='SeatJoined'
      AND j.payload->>'accountId'=${accountParam}::text
      AND NOT EXISTS (SELECT 1 FROM events r WHERE r.session_id=j.session_id AND r.type='SeatRevoked'
        AND r.payload->>'seatId'=j.payload->>'seatId' AND r.seq>j.seq))`;
}

/** Events that create current membership, excluding any join superseded by revocation. */
export function currentMemberEventsSql(sessionParam: string): string {
  return `SELECT j.* FROM events j WHERE j.session_id=${sessionParam} AND j.type='SeatJoined'
    AND NOT EXISTS (SELECT 1 FROM events r WHERE r.session_id=j.session_id AND r.type='SeatRevoked'
      AND r.payload->>'seatId'=j.payload->>'seatId' AND r.seq>j.seq)`;
}

/** The active seat id for account `accountParam` in room alias `s` (undefined when revoked). */
export function currentSeatIdSql(accountParam: string): string {
  return `(SELECT j.payload->>'seatId' FROM events j WHERE j.session_id=s.id AND j.type='SeatJoined'
    AND j.payload->>'accountId'=${accountParam}::text
    AND NOT EXISTS (SELECT 1 FROM events r WHERE r.session_id=j.session_id AND r.type='SeatRevoked'
      AND r.payload->>'seatId'=j.payload->>'seatId' AND r.seq>j.seq)
    ORDER BY j.seq DESC LIMIT 1)`;
}
