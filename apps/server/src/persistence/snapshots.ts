import type { PoolClient } from 'pg';

export interface Snapshot {
  sessionId: string;
  seq: number;
  state: unknown;
  createdAt: Date;
}

export async function insertSnapshot(
  client: PoolClient,
  sessionId: string,
  seq: number,
  state: unknown,
): Promise<Snapshot> {
  const result = await client.query<{ created_at: Date }>(
    'INSERT INTO snapshots(session_id,seq,state) VALUES ($1,$2,$3) RETURNING created_at',
    [sessionId, seq, JSON.stringify(state)],
  );
  return {
    sessionId,
    seq,
    state,
    createdAt: result.rows[0]?.created_at ?? new Date(),
  };
}
