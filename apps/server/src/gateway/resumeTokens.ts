import { createHash, randomBytes } from 'node:crypto';
import type { Pool } from 'pg';

const hash = (token: string) =>
  createHash('sha256').update(token).digest('hex');

export type SeatSocketAuthorization =
  | { status: 'authorized'; resumeToken: string; soloOwnerRecovery: boolean }
  | { status: 'active-socket' | 'invalid-token' };

/** Atomically checks the current seat token and claims its sole controlling socket. */
export async function authorizeSeatSocket(
  db: Pool,
  sessionId: string,
  seatId: string,
  socketId: string,
  presentedToken: string | undefined,
  hostApprovedClaim = false,
  accountId?: string,
  allowSoloOwnerRecovery = false,
): Promise<SeatSocketAuthorization> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const key = `${sessionId}:${seatId}`;
    await client.query(
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      [key],
    );
    const result = await client.query<{
      token_hash: string;
      active_socket_id: string | null;
      heartbeat_at: Date | null;
      socket_live: boolean;
    }>(
      `SELECT token_hash,active_socket_id,heartbeat_at,
              (active_socket_id IS NOT NULL AND heartbeat_at > clock_timestamp() - interval '15 seconds') AS socket_live
         FROM seat_resume_tokens WHERE session_id=$1 AND seat_id=$2 FOR UPDATE`,
      [sessionId, seatId],
    );
    const row = result.rows[0];
    // A live controller always wins before any token-recovery exception.
    if (row?.socket_live) {
      await client.query('ROLLBACK');
      return { status: 'active-socket' };
    }
    let soloOwnerRecovery = false;
    const needsOwnerRecovery =
      !row || !presentedToken || hash(presentedToken) !== row.token_hash;
    if (allowSoloOwnerRecovery && accountId && needsOwnerRecovery) {
      // Serialize seat-count/mode eligibility with seat joins and session conversion.
      await client.query('SELECT id FROM sessions WHERE id=$1 FOR UPDATE', [
        sessionId,
      ]);
      const recovery = await client.query<{ allowed: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM sessions s JOIN events j ON j.session_id=s.id
            WHERE s.id=$1 AND s.status='active' AND s.mode='solo'
              AND s.owner_account_id=$3::uuid AND j.type='SeatJoined'
              AND j.payload->>'seatId'=$2 AND j.payload->>'accountId'=$3::text
              AND NOT EXISTS (SELECT 1 FROM events r WHERE r.session_id=j.session_id
                AND r.type='SeatRevoked' AND r.payload->>'seatId'=$2 AND r.seq>j.seq)
              AND (SELECT count(DISTINCT live.payload->>'seatId') FROM events live
                WHERE live.session_id=s.id AND live.type='SeatJoined'
                  AND NOT EXISTS (SELECT 1 FROM events revoked WHERE revoked.session_id=live.session_id
                    AND revoked.type='SeatRevoked'
                    AND revoked.payload->>'seatId'=live.payload->>'seatId'
                    AND revoked.seq>live.seq))=1
         ) AS allowed`,
        [sessionId, seatId, accountId],
      );
      soloOwnerRecovery = recovery.rows[0]?.allowed === true;
    }
    if (hostApprovedClaim) {
      if (!row || !accountId) {
        await client.query('ROLLBACK');
        return { status: 'invalid-token' };
      }
      const membership = await client.query<{ current: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM sessions s JOIN events j ON j.session_id=s.id
            WHERE s.id=$1 AND s.status='active' AND j.type='SeatJoined'
              AND j.payload->>'seatId'=$2 AND j.payload->>'accountId'=$3
              AND NOT EXISTS (SELECT 1 FROM events r WHERE r.session_id=j.session_id
                AND r.type='SeatRevoked' AND r.payload->>'seatId'=$2 AND r.seq>j.seq)
         ) AS current`,
        [sessionId, seatId, accountId],
      );
      if (!membership.rows[0]?.current) {
        await client.query('ROLLBACK');
        return { status: 'invalid-token' };
      }
    }
    // Missing or stale tokens require host approval except for a current solo
    // owner, whose ownership and seat membership were verified above.
    if (
      (!row && !soloOwnerRecovery) ||
      (!hostApprovedClaim &&
        !soloOwnerRecovery &&
        (!presentedToken || hash(presentedToken) !== row?.token_hash))
    ) {
      await client.query('ROLLBACK');
      return { status: 'invalid-token' };
    }
    const resumeToken = randomBytes(16).toString('base64url');
    await client.query(
      `INSERT INTO seat_resume_tokens
         (session_id,seat_id,token_hash,rotated_at,active_socket_id,heartbeat_at)
       VALUES($1,$2,md5(random()::text || clock_timestamp()::text),clock_timestamp(),$3,clock_timestamp())
       ON CONFLICT(session_id,seat_id) DO UPDATE SET
         active_socket_id=EXCLUDED.active_socket_id,
         heartbeat_at=EXCLUDED.heartbeat_at`,
      [sessionId, seatId, socketId],
    );
    await client.query('COMMIT');
    return { status: 'authorized', resumeToken, soloOwnerRecovery };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** Rotates only after the authenticated frame has been accepted by the socket. */
export async function commitSeatResumeToken(
  db: Pool,
  sessionId: string,
  seatId: string,
  socketId: string,
  resumeToken: string,
): Promise<boolean> {
  const result = await db.query(
    `UPDATE seat_resume_tokens
        SET token_hash=$4,rotated_at=clock_timestamp()
      WHERE session_id=$1 AND seat_id=$2 AND active_socket_id=$3`,
    [sessionId, seatId, socketId, hash(resumeToken)],
  );
  return result.rowCount === 1;
}

export async function releaseSeatSocket(
  db: Pool,
  sessionId: string,
  seatId: string,
  socketId: string,
): Promise<void> {
  await db.query(
    `UPDATE seat_resume_tokens SET active_socket_id=NULL,heartbeat_at=NULL
      WHERE session_id=$1 AND seat_id=$2 AND active_socket_id=$3`,
    [sessionId, seatId, socketId],
  );
}

export async function heartbeatSeatSocket(
  db: Pool,
  sessionId: string,
  seatId: string,
  socketId: string,
): Promise<void> {
  await db.query(
    `UPDATE seat_resume_tokens SET heartbeat_at=clock_timestamp()
      WHERE session_id=$1 AND seat_id=$2 AND active_socket_id=$3`,
    [sessionId, seatId, socketId],
  );
}
