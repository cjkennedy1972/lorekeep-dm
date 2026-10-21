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
