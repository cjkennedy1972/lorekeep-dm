import type { Pool } from 'pg';

/** Apply a five-minute automatic mute without overriding a host's persistent mute. */
export async function applyAutomaticChatMute(
  db: Pick<Pool, 'query'>,
  sessionId: string,
  seatId: string,
): Promise<void> {
  await db.query(
    `INSERT INTO chat_mutes(session_id,seat_id,muted_until,source)
     VALUES($1,$2,now() + interval '5 minutes','automatic')
     ON CONFLICT(session_id,seat_id) DO UPDATE
     SET muted_until=EXCLUDED.muted_until,source='automatic',updated_at=now(),updated_by=NULL
     WHERE chat_mutes.source <> 'host'`,
    [sessionId, seatId],
  );
}

type MuteRow = {
  muted_until: Date | null;
  source: string;
  updated_by: string | null;
};

// Per-(table, seat) tail of pending host mute operations.
// ponytail: in-process only; sessions are single-writer via the room lease.
const locks = new Map<string, Promise<unknown>>();

async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.catch(() => undefined);
  locks.set(key, tail);
  try {
    return await run;
  } finally {
    if (locks.get(key) === tail) locks.delete(key);
  }
}

async function retry(
  fn: () => Promise<unknown>,
  attempts = 3,
): Promise<unknown | undefined> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      await fn();
      return undefined;
    } catch (error) {
      last = error;
    }
  }
  return last ?? new Error('retry failed');
}

/**
 * Host mute/unmute, serialized per (session, seat). Invariant: after any
 * outcome, if in doubt the seat stays muted (enforcement reads the row first).
 * - MUTE: row first, then event; on append failure restore the prior row. A
 *   failed restore leaves the row muted (fail closed) and is logged.
 * - UNMUTE: event first, then delete the row; a failed append deletes nothing.
 *   A failed delete after the event leaves the row (fail closed), is logged and
 *   rejected. `onUnmuted` (in-memory policy lift) runs only after both commit.
 */
export function applyHostChatMute(
  db: Pick<Pool, 'query'>,
  sessionId: string,
  seatId: string,
  muted: boolean,
  actorAccountId: string,
  append: () => Promise<void>,
  logError: (error: unknown, message: string) => void = () => {},
  onUnmuted: () => void = () => {},
): Promise<void> {
  return withLock(`${sessionId}:${seatId}`, async () => {
    const del = () =>
      db.query('DELETE FROM chat_mutes WHERE session_id=$1 AND seat_id=$2', [
        sessionId,
        seatId,
      ]);
    if (!muted) {
      await append();
      const failure = await retry(del);
      if (failure) {
        logError(
          failure,
          'chat unmute event committed but chat_mutes row delete failed; seat stays muted',
        );
        throw failure;
      }
      onUnmuted();
      return;
    }
    const prior = (
      await db.query<MuteRow>(
        'SELECT muted_until,source,updated_by FROM chat_mutes WHERE session_id=$1 AND seat_id=$2',
        [sessionId, seatId],
      )
    ).rows[0];
    await db.query(
      `INSERT INTO chat_mutes(session_id,seat_id,muted_until,source,updated_by)
       VALUES($1,$2,NULL,'host',$3)
       ON CONFLICT(session_id,seat_id) DO UPDATE SET muted_until=NULL,source='host',updated_at=now(),updated_by=EXCLUDED.updated_by`,
      [sessionId, seatId, actorAccountId],
    );
    try {
      await append();
    } catch (error) {
      const failure = await retry(() =>
        prior
          ? db.query(
              `INSERT INTO chat_mutes(session_id,seat_id,muted_until,source,updated_by)
               VALUES($1,$2,$3,$4,$5)
               ON CONFLICT(session_id,seat_id) DO UPDATE SET muted_until=EXCLUDED.muted_until,source=EXCLUDED.source,updated_at=now(),updated_by=EXCLUDED.updated_by`,
              [
                sessionId,
                seatId,
                prior.muted_until,
                prior.source,
                prior.updated_by,
              ],
            )
          : del(),
      );
      if (failure)
        logError(
          failure,
          'chat mute compensation failed; seat stays muted without its event',
        );
      throw error;
    }
  });
}
