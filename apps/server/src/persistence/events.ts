import type { PoolClient } from 'pg';

export interface EventInput {
  seq?: number;
  turnId: string;
  type: string;
  payload: unknown;
}

export interface StoredEvent extends Required<EventInput> {
  sessionId: string;
  ts: Date;
}

export async function appendEvents(
  client: PoolClient,
  sessionId: string,
  events: readonly EventInput[],
): Promise<StoredEvent[]> {
  const result: StoredEvent[] = [];
  const head = await client.query<{ seq: string }>(
    'SELECT COALESCE(MAX(seq), 0)::text AS seq FROM events WHERE session_id = $1',
    [sessionId],
  );
  let seq = Number(head.rows[0]?.seq ?? 0);
  for (const event of events) {
    const next = seq + 1;
    if (event.seq !== undefined && event.seq !== next) {
      throw new Error(
        `Non-contiguous event seq: expected ${next}, got ${event.seq}`,
      );
    }
    const inserted = await client.query<{
      session_id: string;
      seq: string;
      turn_id: string;
      type: string;
      payload: unknown;
      ts: Date;
    }>(
      'INSERT INTO events(session_id,seq,turn_id,type,payload) VALUES ($1,$2,$3,$4,$5) RETURNING *',
      [
        sessionId,
        next,
        event.turnId,
        event.type,
        JSON.stringify(event.payload),
      ],
    );
    const row = inserted.rows[0];
    if (!row) throw new Error('Event insert returned no row');
    result.push({
      sessionId: row.session_id,
      seq: Number(row.seq),
      turnId: row.turn_id,
      type: row.type,
      payload: row.payload,
      ts: row.ts,
    });
    seq = next;
  }
  return result;
}
