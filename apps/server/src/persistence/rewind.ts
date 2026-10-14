export interface RewindRow {
  seq: number;
  turnId: string;
  type: string;
  payload: unknown;
}

export interface RewindTarget {
  turnId: string;
  firstSeq: number;
  rewindUsed: boolean;
}

/** Room-level events a rewind keeps even when logged after the reverted turn began. */
export const ROOM_STATE_EVENT_TYPES = [
  'SeatJoined',
  'PresenceChanged',
  'TablePaused',
  'SafetyFlag',
  'ClarificationClosed',
] as const;

/** SQL predicate on `events` (parameter $1 = session id) that hides rows of reverted turns. */
export const REVERTED_TURN_EXCLUSION = `turn_id::text NOT IN (SELECT payload->>'revertedTurnId' FROM events WHERE session_id = $1 AND type = 'TurnReverted')`;

/** Latest DM turn not yet reverted. Any rewind logged after its narration uses up that turn's rewind. */
export function findRewindTarget(
  rows: readonly RewindRow[],
): RewindTarget | null {
  const reverted = new Set(
    rows
      .filter((row) => row.type === 'TurnReverted')
      .map((row) => (row.payload as { revertedTurnId: string }).revertedTurnId),
  );
  const narrated = rows
    .filter(
      (row) => row.type === 'NarrationCompleted' && !reverted.has(row.turnId),
    )
    .at(-1);
  if (!narrated) return null;
  const firstSeq = rows.find((row) => row.turnId === narrated.turnId)!.seq;
  const rewindUsed = rows.some(
    (row) => row.type === 'TurnReverted' && row.seq > narrated.seq,
  );
  return { turnId: narrated.turnId, firstSeq, rewindUsed };
}
