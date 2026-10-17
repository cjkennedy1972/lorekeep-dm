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
