import { randomBytes } from 'node:crypto';
import type { PoolClient } from 'pg';

export interface SeatStream {
  sessionId: string;
  seatId: string;
  bindingEpoch: number;
  generation: string;
  cursor: number;
}

// Keep nonce creation server-side; no client-supplied value can select a generation.
function generationNonce(): string {
  return randomBytes(16).toString('base64url');
}

function parseRow(row: {
  session_id: string;
  seat_id: string;
  binding_epoch: string;
  generation: string;
  cursor: string;
}): SeatStream | null {
  // PostgreSQL bigint values arrive as text; reject values JS cannot represent exactly.
  const bindingEpoch = Number(row.binding_epoch);
  const cursor = Number(row.cursor);
  if (
    !Number.isSafeInteger(bindingEpoch) ||
    bindingEpoch < 1 ||
    !Number.isSafeInteger(cursor) ||
    cursor < 0 ||
    !/^[A-Za-z0-9_-]{22}$/.test(row.generation)
  )
    return null;
  return {
    sessionId: row.session_id,
    seatId: row.seat_id,
    bindingEpoch,
    generation: row.generation,
    cursor,
  };
}

const RETURNING = `session_id, seat_id, binding_epoch::text, generation, cursor::text`;

/** Create the initial independent stream record, or return its existing value. */
export async function initializeSeatStream(
  client: PoolClient,
  sessionId: string,
  seatId: string,
): Promise<SeatStream> {
  const nonce = generationNonce();
  const result = await client.query(
    `INSERT INTO seat_streams(session_id, seat_id, binding_epoch, generation, cursor)
     VALUES ($1, $2, 1, $3, 0)
     ON CONFLICT (session_id, seat_id) DO NOTHING
     RETURNING ${RETURNING}`,
    [sessionId, seatId, nonce],
  );
  const row =
    result.rows[0] ??
    (
      await client.query(
        `SELECT ${RETURNING} FROM seat_streams WHERE session_id=$1 AND seat_id=$2`,
        [sessionId, seatId],
      )
    ).rows[0];
  const stream = row && parseRow(row);
  if (!stream) throw new Error('seat_stream_record_invalid');
  return stream;
}

export async function loadSeatStream(
  client: PoolClient,
  sessionId: string,
  seatId: string,
): Promise<SeatStream | null> {
  const result = await client.query(
    `SELECT ${RETURNING} FROM seat_streams WHERE session_id=$1 AND seat_id=$2`,
    [sessionId, seatId],
  );
  const row = result.rows[0];
  return row ? parseRow(row) : null;
}

/** Advance only the identified generation; callers share this client's transaction with the event commit. */
export async function advanceSeatStream(
  client: PoolClient,
  stream: Pick<
    SeatStream,
    'sessionId' | 'seatId' | 'bindingEpoch' | 'generation'
  >,
  by = 1,
): Promise<number> {
  if (!Number.isSafeInteger(by) || by < 1)
    throw new Error('seat_stream_increment_invalid');
  const result = await client.query<{ cursor: string }>(
    `UPDATE seat_streams SET cursor=cursor+$5
     WHERE session_id=$1 AND seat_id=$2 AND binding_epoch=$3 AND generation=$4
     RETURNING cursor::text`,
    [
      stream.sessionId,
      stream.seatId,
      stream.bindingEpoch,
      stream.generation,
      by,
    ],
  );
  const cursor = Number(result.rows[0]?.cursor);
  if (!Number.isSafeInteger(cursor))
    throw new Error('seat_stream_generation_changed');
  return cursor;
}

/**
 * Replace a damaged/missing stream at the same binding epoch with a fresh nonce.
 * Callers must validate current seat membership before using this persistence helper.
 */
export async function reinitializeSeatStream(
  client: PoolClient,
  sessionId: string,
  seatId: string,
  bindingEpoch: number,
): Promise<SeatStream> {
  if (!Number.isSafeInteger(bindingEpoch) || bindingEpoch < 1)
    throw new Error('seat_stream_epoch_invalid');
  const result = await client.query(
    `INSERT INTO seat_streams(session_id, seat_id, binding_epoch, generation, cursor)
     VALUES ($1,$2,$3,$4,0)
     ON CONFLICT (session_id, seat_id) DO UPDATE SET
       generation=EXCLUDED.generation, cursor=0
     WHERE seat_streams.binding_epoch = EXCLUDED.binding_epoch
     RETURNING ${RETURNING}`,
    [sessionId, seatId, bindingEpoch, generationNonce()],
  );
  if (result.rowCount === 0) throw new Error('seat_stream_epoch_mismatch');
  const stream = parseRow(result.rows[0]);
  if (!stream) throw new Error('seat_stream_record_invalid');
  return stream;
}
