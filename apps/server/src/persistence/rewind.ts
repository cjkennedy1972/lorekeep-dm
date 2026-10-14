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
