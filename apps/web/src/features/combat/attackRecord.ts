/**
 * The attack actionIds this seat sent in one game. They live outside the Game component, so a remount
 * of the screen (same game id, same page) keeps them and a late COMMAND_REJECTED can still be matched.
 * A record is dropped once no Game screen for its id is mounted.
 */
export type AttackRecord = {
  /** The newest attack this seat sent; only its rejection may explain itself. */
  latest: string | null;
  /** Every attack actionId this seat sent in the game. */
  sent: Set<string>;
};

type Entry = AttackRecord & {
  holders: number;
  timer?: ReturnType<typeof setTimeout>;
};

const records = new Map<string, Entry>();

/** The record for a game, created on first use. Safe to call during render. */
export function attackRecordFor(gameId: string): AttackRecord {
  return entryFor(gameId);
}

function entryFor(gameId: string): Entry {
  let entry = records.get(gameId);
  if (!entry) {
    entry = { latest: null, sent: new Set(), holders: 0 };
    records.set(gameId, entry);
  }
  return entry;
}

/**
 * Marks a Game screen as mounted for this id. The returned release does not drop the record at once:
 * it is dropped on the next timer tick, so a remount in the same page keeps its attack ids.
 */
export function retainAttackRecord(gameId: string): () => void {
  const entry = entryFor(gameId);
  entry.holders += 1;
  clearTimeout(entry.timer);
  return () => {
    entry.holders -= 1;
    if (entry.holders > 0) return;
    entry.timer = setTimeout(() => {
      if (entry.holders === 0 && records.get(gameId) === entry)
        records.delete(gameId);
    }, 0);
  };
}
