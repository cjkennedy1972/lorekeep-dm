import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';

const hash = (token: string) =>
  createHash('sha256').update(token).digest('hex');
const unresolvedInvalidations = new Set<string>();
const seatKey = (sessionId: string, seatId: string) => `${sessionId}:${seatId}`;

export type SeatResumeCandidateActivation =
  | 'activated'
  | 'already-activated'
  | 'rejected';

export type SeatResumeCandidateStart =
  | { status: 'started'; rotationId: string; candidate: string }
  | { status: 'rate-limited' | 'pending' | 'lease-lost' };

/** Persist a non-authenticating candidate, charging only a successful ordinary start. */
export async function beginSeatResumeCandidate(
  db: Pool,
  sessionId: string,
  seatId: string,
  socketId: string,
  ownerRecovery = false,
): Promise<SeatResumeCandidateStart> {
  const rotationId = randomUUID();
  const candidate = randomBytes(16).toString('base64url');
  const result = await db.query<{ pending_rotation_id: string }>(
    `UPDATE seat_resume_tokens SET
       pending_token_hash=$4, pending_rotation_id=$5, pending_socket_id=$3,
       pending_expires_at=clock_timestamp()+interval '30 seconds', pending_started_at=clock_timestamp(),
       pending_owner_recovery=$6,
       rotation_window_started_at=CASE WHEN $6 THEN rotation_window_started_at
         WHEN rotation_window_started_at IS NULL OR rotation_window_started_at+interval '60 seconds'<=clock_timestamp() THEN clock_timestamp()
         ELSE rotation_window_started_at END,
       rotation_starts_in_window=CASE WHEN $6 THEN rotation_starts_in_window
         WHEN rotation_window_started_at IS NULL OR rotation_window_started_at+interval '60 seconds'<=clock_timestamp() THEN 1
         ELSE rotation_starts_in_window+1 END
     WHERE session_id=$1 AND seat_id=$2 AND active_socket_id=$3
       AND heartbeat_at>clock_timestamp()-interval '15 seconds'
       AND (pending_rotation_id IS NULL OR pending_expires_at<=clock_timestamp())
       AND ($6 OR rotation_window_started_at IS NULL
         OR rotation_window_started_at+interval '60 seconds'<=clock_timestamp() OR rotation_starts_in_window<6)
     RETURNING pending_rotation_id`,
    [sessionId, seatId, socketId, hash(candidate), rotationId, ownerRecovery],
  );
  if (result.rowCount === 1)
    return { status: 'started', rotationId, candidate };
  const state = await db.query<{
    pending: boolean;
    limited: boolean;
    live: boolean;
  }>(
    `SELECT (active_socket_id=$4::uuid AND heartbeat_at>clock_timestamp()-interval '15 seconds') AS live,
       (pending_rotation_id IS NOT NULL AND pending_expires_at>clock_timestamp()) AS pending,
       (NOT $3::boolean AND rotation_window_started_at IS NOT NULL
         AND rotation_window_started_at+interval '60 seconds'>clock_timestamp() AND rotation_starts_in_window>=6) AS limited
     FROM seat_resume_tokens WHERE session_id=$1 AND seat_id=$2 AND active_socket_id=$4::uuid`,
    [sessionId, seatId, ownerRecovery, socketId],
  );
  if (!state.rows.length || !state.rows[0]!.live)
    return { status: 'lease-lost' };
  if (state.rows[0]!.pending) return { status: 'pending' };
  if (state.rows[0]!.limited) return { status: 'rate-limited' };
  return { status: 'lease-lost' };
}

/** Activate only the exact live pending tuple; activation and budget refund are one CAS. */
export async function activateSeatResumeCandidate(
  db: Pool,
  sessionId: string,
  seatId: string,
  socketId: string,
  rotationId: string,
  candidate: string,
  _callerOwnerRecovery = false,
): Promise<SeatResumeCandidateActivation> {
  const result = await db.query(
    `UPDATE seat_resume_tokens SET token_hash=pending_token_hash, rotated_at=clock_timestamp(),
       last_activated_rotation_id=pending_rotation_id, last_activated_socket_id=pending_socket_id,
       last_activated_at=clock_timestamp(),
       rotation_starts_in_window=CASE WHEN NOT pending_owner_recovery AND pending_started_at>=rotation_window_started_at
           AND clock_timestamp()<rotation_window_started_at+interval '60 seconds'
         THEN rotation_starts_in_window-1 ELSE rotation_starts_in_window END,
       rotation_window_started_at=CASE WHEN NOT pending_owner_recovery AND pending_started_at>=rotation_window_started_at
           AND clock_timestamp()<rotation_window_started_at+interval '60 seconds'
           AND rotation_starts_in_window=1 THEN NULL ELSE rotation_window_started_at END,
       pending_token_hash=NULL, pending_rotation_id=NULL, pending_socket_id=NULL,
       pending_expires_at=NULL, pending_started_at=NULL, pending_owner_recovery=false
     WHERE session_id=$1 AND seat_id=$2 AND active_socket_id=$3
       AND heartbeat_at>clock_timestamp()-interval '15 seconds'
       AND pending_rotation_id=$4 AND pending_socket_id=$3 AND pending_token_hash=$5
       AND pending_expires_at>clock_timestamp()`,
    [sessionId, seatId, socketId, rotationId, hash(candidate)],
  );
  if (result.rowCount === 1) return 'activated';
  const duplicate = await db.query(
    `SELECT 1 FROM seat_resume_tokens
     WHERE session_id=$1 AND seat_id=$2 AND active_socket_id=$3
       AND heartbeat_at>clock_timestamp()-interval '15 seconds'
       AND last_activated_rotation_id=$4 AND last_activated_socket_id=$3
       AND last_activated_at>clock_timestamp()-interval '30 seconds'`,
    [sessionId, seatId, socketId, rotationId],
  );
  return duplicate.rowCount === 1 ? 'already-activated' : 'rejected';
}

const unmatchableTokenHash = () =>
  createHash('sha256').update(randomBytes(32)).digest('hex');

export function markSeatResumeTokenInvalidationPending(
  sessionId: string,
  seatId: string,
): void {
  unresolvedInvalidations.add(seatKey(sessionId, seatId));
}

export function clearSeatResumeTokenInvalidationPending(
  sessionId: string,
  seatId: string,
): void {
  unresolvedInvalidations.delete(seatKey(sessionId, seatId));
}

export type SeatSocketAuthorization =
  | {
      status: 'authorized';
      resumeToken: string;
      soloOwnerRecovery: boolean;
      previousTokenHash: string;
    }
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
    if (presentedToken && unresolvedInvalidations.has(key)) {
      await client.query('ROLLBACK');
      return { status: 'invalid-token' };
    }
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
    const reserved = await client.query<{ token_hash: string }>(
      `INSERT INTO seat_resume_tokens
         (session_id,seat_id,token_hash,rotated_at,active_socket_id,heartbeat_at)
       VALUES($1,$2,$4,clock_timestamp(),$3,clock_timestamp())
       ON CONFLICT(session_id,seat_id) DO UPDATE SET
         active_socket_id=EXCLUDED.active_socket_id,
         heartbeat_at=EXCLUDED.heartbeat_at
       RETURNING token_hash`,
      [sessionId, seatId, socketId, unmatchableTokenHash()],
    );
    const previousTokenHash = reserved.rows[0]?.token_hash;
    if (!previousTokenHash)
      throw new Error('seat resume token reservation failed');
    await client.query('COMMIT');
    return {
      status: 'authorized',
      resumeToken,
      soloOwnerRecovery,
      previousTokenHash,
    };
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

/** Restores the prior credential only while this socket still owns this rotation. */
export async function rollbackSeatResumeToken(
  db: Pool,
  sessionId: string,
  seatId: string,
  socketId: string,
  resumeToken: string,
  previousTokenHash: string,
): Promise<boolean> {
  const key = seatKey(sessionId, seatId);
  // Never restore a credential whose invalidation is still unresolved. Keep the
  // CAS against T2, but replace the row with a hash no client can know.
  const restoreHash = unresolvedInvalidations.has(key)
    ? unmatchableTokenHash()
    : previousTokenHash;
  const result = await db.query(
    `UPDATE seat_resume_tokens
        SET token_hash=$5,rotated_at=clock_timestamp()
      WHERE session_id=$1 AND seat_id=$2
        AND (active_socket_id=$3 OR active_socket_id IS NULL)
        AND token_hash=$4`,
    [sessionId, seatId, socketId, hash(resumeToken), restoreHash],
  );
  return result.rowCount === 1;
}

/** Replaces an undelivered credential only while its hash and socket lease match. */
export async function invalidateSeatResumeToken(
  db: Pool,
  sessionId: string,
  seatId: string,
  socketId: string,
  resumeToken: string,
): Promise<boolean> {
  const replacementHash = unmatchableTokenHash();
  const result = await db.query(
    `UPDATE seat_resume_tokens
        SET token_hash=$5,rotated_at=clock_timestamp()
      WHERE session_id=$1 AND seat_id=$2
        AND (active_socket_id=$3 OR active_socket_id IS NULL)
        AND token_hash=$4`,
    [sessionId, seatId, socketId, hash(resumeToken), replacementHash],
  );
  if (result.rowCount === 1) return true;
  const current = await db.query<{ token_hash: string }>(
    'SELECT token_hash FROM seat_resume_tokens WHERE session_id=$1 AND seat_id=$2',
    [sessionId, seatId],
  );
  return current.rows[0]?.token_hash !== hash(resumeToken);
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
