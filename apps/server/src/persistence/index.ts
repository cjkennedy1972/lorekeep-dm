import type { Pool, PoolClient } from 'pg';
import { RegistryMemory, type RegistryEvent } from '../dm/memory.js';
import { appendEvents, type EventInput, type StoredEvent } from './events.js';
import { insertSnapshot, type Snapshot } from './snapshots.js';

export type { EventInput, StoredEvent } from './events.js';
export type { Snapshot } from './snapshots.js';

export interface LeaseFence {
  nodeId: string;
  epoch: number;
}

export interface LatestState {
  snapshot: Snapshot | null;
  events: StoredEvent[];
}

export class Persistence {
  readonly db: Pool;
  constructor(private readonly pool: Pool) {
    this.db = pool;
  }

  private async transaction<T>(
    sessionId: string,
    lease: LeaseFence | undefined,
    work: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const locked = await client.query(
        'SELECT id FROM sessions WHERE id = $1 FOR UPDATE',
        [sessionId],
      );
      if (locked.rowCount !== 1)
        throw new Error(`Session not found: ${sessionId}`);
      const fence = await client.query<{
        node_id: string;
        epoch: string;
        live: boolean;
      }>(
        'SELECT node_id, epoch, expires_at > clock_timestamp() AS live FROM session_lease WHERE session_id=$1 FOR UPDATE',
        [sessionId],
      );
      const current = fence.rows[0];
      if (
        current &&
        (!lease ||
          !current.live ||
          current.node_id !== lease.nodeId ||
          Number(current.epoch) !== lease.epoch)
      ) {
        throw new Error('Lease fencing check failed');
      }
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  persistRegistryEvents(
    sessionId: string,
    events: readonly RegistryEvent[],
    lease?: LeaseFence,
  ): Promise<void> {
    if (!events.length) return Promise.resolve();
    return this.transaction(sessionId, lease, async (client) => {
      await new RegistryMemory(this.pool).persistEventsInTransaction(
        client,
        sessionId,
        events,
      );
    });
  }

  append(
    sessionId: string,
    events: readonly EventInput[],
    lease?: LeaseFence,
  ): Promise<StoredEvent[]> {
    return this.transaction(sessionId, lease, (client) =>
      appendEvents(client, sessionId, events),
    );
  }

  writeTurn(
    sessionId: string,
    events: readonly EventInput[],
    state: unknown,
    lease?: LeaseFence,
    registryEvents: readonly RegistryEvent[] = [],
  ): Promise<{ events: StoredEvent[]; snapshot: Snapshot }> {
    if (events.length === 0) throw new Error('A turn needs at least one event');
    return this.transaction(sessionId, lease, async (client) => {
      if (registryEvents.length)
        await new RegistryMemory(this.pool).persistEventsInTransaction(
          client,
          sessionId,
          registryEvents,
        );
      const inserted = await appendEvents(client, sessionId, events);
      const last = inserted.at(-1);
      if (!last) throw new Error('A turn needs at least one event');
      await client.query(
        'UPDATE sessions SET last_active_at=now() WHERE id=$1',
        [sessionId],
      );
      for (const event of events)
        if (event.type === 'ContentTierChanged')
          await client.query(
            'UPDATE sessions SET content_tier=$2 WHERE id=$1 AND content_tier IS DISTINCT FROM $2',
            [sessionId, (event.payload as { to: string }).to],
          );
      const snapshot = await insertSnapshot(client, sessionId, last.seq, state);
      return { events: inserted, snapshot };
    });
  }

  async loadLatest(sessionId: string): Promise<LatestState> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const snapshots = await client.query<{
        seq: string;
        state: unknown;
        created_at: Date;
      }>(
        'SELECT seq, state, created_at FROM snapshots WHERE session_id = $1 ORDER BY seq DESC LIMIT 1',
        [sessionId],
      );
      const row = snapshots.rows[0];
      const snapshot = row
        ? {
            sessionId,
            seq: Number(row.seq),
            state: row.state,
            createdAt: row.created_at,
          }
        : null;
      const tail = await client.query<{
        seq: string;
        turn_id: string;
        type: string;
        payload: unknown;
        ts: Date;
      }>(
        'SELECT seq,turn_id,type,payload,ts FROM events WHERE session_id = $1 AND seq > $2 ORDER BY seq',
        [sessionId, snapshot?.seq ?? 0],
      );
      await client.query('COMMIT');
      return {
        snapshot,
        events: tail.rows.map((event) => ({
          sessionId,
          seq: Number(event.seq),
          turnId: event.turn_id,
          type: event.type,
          payload: event.payload,
          ts: event.ts,
        })),
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}
