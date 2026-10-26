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

/**
 * Host mute/unmute: DB row and room event must agree after every outcome.
 * The row is written first (so enforcement is never behind the event), then
 * `append` commits the ChatMuteChanged event. If `append` fails the prior row
 * is restored (retried; logged if it still fails) and the error is rethrown.
 */
export async function applyHostChatMute(
  db: Pick<Pool, 'query'>,
  sessionId: string,
  seatId: string,
  muted: boolean,
  actorAccountId: string,
  append: () => Promise<void>,
  logError: (error: unknown, message: string) => void = () => {},
): Promise<void> {
  const prior = (
    await db.query<MuteRow>(
      'SELECT muted_until,source,updated_by FROM chat_mutes WHERE session_id=$1 AND seat_id=$2',
      [sessionId, seatId],
    )
  ).rows[0];
  if (muted)
    await db.query(
      `INSERT INTO chat_mutes(session_id,seat_id,muted_until,source,updated_by)
       VALUES($1,$2,NULL,'host',$3)
       ON CONFLICT(session_id,seat_id) DO UPDATE SET muted_until=NULL,source='host',updated_at=now(),updated_by=EXCLUDED.updated_by`,
      [sessionId, seatId, actorAccountId],
    );
  else
    await db.query(
      'DELETE FROM chat_mutes WHERE session_id=$1 AND seat_id=$2',
      [sessionId, seatId],
    );
  try {
    await append();
  } catch (error) {
    for (let attempt = 1; ; attempt++) {
      try {
        if (prior)
          await db.query(
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
          );
        else
          await db.query(
            'DELETE FROM chat_mutes WHERE session_id=$1 AND seat_id=$2',
            [sessionId, seatId],
          );
        break;
      } catch (restoreError) {
        if (attempt >= 3) {
          logError(
            restoreError,
            'chat mute compensation failed; chat_mutes may disagree with room state',
          );
          break;
        }
      }
    }
    throw error;
  }
}
