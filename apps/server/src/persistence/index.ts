import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { ChatMessageSchema, type ChatHistoryEntry } from '@game/schema';
import { RegistryMemory, type RegistryEvent } from '../dm/memory.js';
import type { HostCap } from '../safety/tier.js';
import { appendEvents, type EventInput, type StoredEvent } from './events.js';
import { insertSnapshot, type Snapshot } from './snapshots.js';
import { currentMemberSql } from '../room/membership.js';
import {
  findRewindTarget,
  REVERTED_TURN_EXCLUSION,
  ROOM_STATE_EVENT_TYPES,
} from './rewind.js';

export type { EventInput, StoredEvent } from './events.js';
export type { Snapshot } from './snapshots.js';

export interface RewindPlan {
  turnId: string;
  rewindUsed: boolean;
  before: LatestState;
  retained: StoredEvent[];
  headSeq: number;
  droppedTurnIds: string[];
}

export interface LeaseFence {
  nodeId: string;
  epoch: number;
}

/** The session is held by another Room or writer; the caller may retry. */
export class LeaseConflictError extends Error {
  readonly retryable = true;
}

export class RewindRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RewindRefusedError';
  }
}

export class ChatSeatRevokedError extends Error {
  constructor() {
    super('Current seat is required to commit chat');
    this.name = 'ChatSeatRevokedError';
  }
}

export interface LatestState {
  snapshot: Snapshot | null;
  events: StoredEvent[];
}

async function applyHostTierCap(
  client: PoolClient,
  sessionId: string,
  cap: HostCap | null,
  seq?: number,
): Promise<StoredEvent[]> {
  const from =
    (
      await client.query<{ host_tier_cap: HostCap | null }>(
        'SELECT host_tier_cap FROM sessions WHERE id=$1',
        [sessionId],
      )
    ).rows[0]?.host_tier_cap ?? null;
  if (from === cap) return [];
  await client.query('UPDATE sessions SET host_tier_cap=$2 WHERE id=$1', [
    sessionId,
    cap,
  ]);
  return appendEvents(client, sessionId, [
    {
      seq,
      turnId: randomUUID(),
      type: 'HostTierCapChanged',
      payload: { from, to: cap },
    },
  ]);
}

export class Persistence {
  readonly db: Pool;
  async createSeatResumeToken(
    sessionId: string,
    seatId: string,
  ): Promise<string> {
    const token = randomBytes(24).toString('base64url');
    const tokenHash = createHash('sha256').update(token).digest('hex');
    await this.pool.query(
      `INSERT INTO seat_resume_tokens(session_id,seat_id,token_hash,rotated_at)
       VALUES($1,$2,$3,clock_timestamp())
       ON CONFLICT(session_id,seat_id) DO UPDATE SET
         token_hash=EXCLUDED.token_hash,rotated_at=EXCLUDED.rotated_at,
         active_socket_id=NULL,heartbeat_at=NULL`,
      [sessionId, seatId, tokenHash],
    );
    return token;
  }

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
      const stale = lease
        ? !current ||
          !current.live ||
          current.node_id !== lease.nodeId ||
          Number(current.epoch) !== lease.epoch
        : current !== undefined;
      if (stale) {
        throw new LeaseConflictError('Lease fencing check failed');
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

  writeChat(
    sessionId: string,
    event: EventInput,
    lease: LeaseFence,
  ): Promise<StoredEvent> {
    return this.transaction(sessionId, lease, async (client) => {
      if (event.type === 'chat.committed') {
        const accountId = (event.payload as { accountId?: unknown }).accountId;
        if (typeof accountId !== 'string') throw new ChatSeatRevokedError();
        const membership = await client.query<{ current: boolean }>(
          `SELECT ${currentMemberSql('$2')} AS current FROM sessions s WHERE s.id=$1`,
          [sessionId, accountId],
        );
        if (membership.rows[0]?.current !== true)
          throw new ChatSeatRevokedError();
      }
      const [stored] = await appendEvents(client, sessionId, [event]);
      if (!stored) throw new Error('Chat event was not persisted');
      return stored;
    });
  }

  async loadChatHistory(
    sessionId: string,
    limit = 100,
  ): Promise<ChatHistoryEntry[]> {
    const { rows } = await this.pool.query<{ seq: string; payload: unknown }>(
      `SELECT seq,payload FROM events
        WHERE session_id=$1 AND type='chat.committed'
          AND (expires_at IS NULL OR expires_at>now())
        ORDER BY seq DESC LIMIT $2`,
      [sessionId, Math.max(1, Math.min(limit, 100))],
    );
    return rows
      .flatMap(({ seq, payload }) => {
        const record = { ...(payload as Record<string, unknown>) };
        delete record.accountId;
        const parsed = ChatMessageSchema.safeParse(record);
        return parsed.success
          ? [{ seq: Number(seq), message: parsed.data }]
          : [];
      })
      .reverse();
  }

  async tableHostAccountId(sessionId: string): Promise<string | undefined> {
    const { rows } = await this.pool.query<{ owner_account_id: string }>(
      'SELECT owner_account_id FROM sessions WHERE id=$1',
      [sessionId],
    );
    return rows[0]?.owner_account_id;
  }

  async transferTableHost(
    sessionId: string,
    currentAccountId: string,
    newAccountId: string,
  ): Promise<void> {
    const result = await this.pool.query(
      "UPDATE sessions SET owner_account_id=$3 WHERE id=$1 AND owner_account_id=$2 AND status='active'",
      [sessionId, currentAccountId, newAccountId],
    );
    if (result.rowCount !== 1)
      throw new Error('Host transfer was not authorized');
  }

  async endTable(sessionId: string): Promise<void> {
    const result = await this.pool.query(
      "UPDATE sessions SET status='ended', archived_at=now() WHERE id=$1 AND status='active'",
      [sessionId],
    );
    if (result.rowCount !== 1) throw new Error('Table is not active');
  }

  async isTableHost(sessionId: string, accountId: string): Promise<boolean> {
    const { rows } = await this.pool.query<{ host: boolean }>(
      'SELECT owner_account_id=$2 AS host FROM sessions WHERE id=$1',
      [sessionId, accountId],
    );
    return rows[0]?.host === true;
  }

  /** Host opt-in: an X-card press aborts the in-flight generation. Off unless set. */
  async xCardAbortEnabled(sessionId: string): Promise<boolean> {
    const { rows } = await this.pool.query<{ enabled: boolean }>(
      'SELECT xcard_abort_inflight AS enabled FROM sessions WHERE id=$1',
      [sessionId],
    );
    return rows[0]?.enabled ?? false;
  }

  /** Host opt-in for aborting in-flight generation when an X-card is pressed. */
  async setXCardAbortEnabled(
    sessionId: string,
    enabled: boolean,
  ): Promise<void> {
    const { rowCount } = await this.pool.query(
      'UPDATE sessions SET xcard_abort_inflight=$2 WHERE id=$1',
      [sessionId, enabled],
    );
    if (rowCount !== 1) throw new Error(`Session not found: ${sessionId}`);
  }

  /** Cap change for a table with no live Room: takes the session lease for the write, as account deletion does. */
  async setHostTierCap(sessionId: string, cap: HostCap | null): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT id FROM sessions WHERE id=$1 FOR UPDATE', [
        sessionId,
      ]);
      const nodeId = randomUUID();
      const taken = await client.query(
        `INSERT INTO session_lease(session_id,node_id,expires_at,epoch)
         VALUES ($1,$2,clock_timestamp() + interval '30 seconds',1)
         ON CONFLICT (session_id) DO UPDATE SET
           node_id = EXCLUDED.node_id, expires_at = EXCLUDED.expires_at, epoch = session_lease.epoch + 1
         WHERE session_lease.expires_at <= clock_timestamp()
         RETURNING epoch`,
        [sessionId, nodeId],
      );
      if (!taken.rowCount)
        throw new LeaseConflictError('Session is busy; retry the cap change.');
      await applyHostTierCap(client, sessionId, cap);
      await client.query(
        `UPDATE session_lease SET node_id='', expires_at=clock_timestamp()
         WHERE session_id=$1 AND node_id=$2`,
        [sessionId, nodeId],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /** Cap change from a live Room: appends at the Room's own seq, fenced by the Room's lease. */
  writeHostTierCap(
    sessionId: string,
    cap: HostCap | null,
    lease: LeaseFence,
    seq: number,
  ): Promise<StoredEvent[]> {
    return this.transaction(sessionId, lease, (client) =>
      applyHostTierCap(client, sessionId, cap, seq),
    );
  }

  writeTurn(
    sessionId: string,
    events: readonly EventInput[],
    state: unknown,
    lease?: LeaseFence,
    registryEvents: readonly RegistryEvent[] = [],
    expectedHeadSeq?: number,
    registryTurnId?: string,
    rewoundTurnIds: readonly string[] = [],
  ): Promise<{ events: StoredEvent[]; snapshot: Snapshot }> {
    if (events.length === 0) throw new Error('A turn needs at least one event');
    return this.transaction(sessionId, lease, async (client) => {
      if (expectedHeadSeq !== undefined) {
        const head = await client.query<{ seq: string }>(
          'SELECT COALESCE(MAX(seq), 0)::text AS seq FROM events WHERE session_id = $1',
          [sessionId],
        );
        if (Number(head.rows[0]!.seq) !== expectedHeadSeq)
          throw new LeaseConflictError(
            'The room log changed while the rewind was planned; retry.',
          );
      }
      if (registryEvents.length)
        await new RegistryMemory(this.pool).persistEventsInTransaction(
          client,
          sessionId,
          registryEvents,
          registryTurnId ?? null,
        );
      const safetyFlags = events.filter((event) => event.type === 'SafetyFlag');
      for (const event of safetyFlags) {
        const payload = event.payload as { seatId?: unknown; kind?: unknown };
        if (payload.kind === 'x-card' && typeof payload.seatId === 'string')
          await client.query(
            `INSERT INTO x_card_log(session_id,seat_id,written_at,expires_at)
             VALUES ($1,$2,now(),now() + interval '30 days')`,
            [sessionId, payload.seatId],
          );
      }
      // Seat-linked data lives only in the expiring operational log. The immutable
      // replay event and snapshots retain the anonymous safety signal only.
      const replayEvents = events.map((event) =>
        event.type === 'SafetyFlag'
          ? { ...event, payload: { kind: 'x-card' } }
          : event,
      );
      const inserted = await appendEvents(client, sessionId, replayEvents);
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
      for (const event of events)
        if (event.type === 'TurnReverted')
          await client.query(
            'DELETE FROM scene_summaries WHERE session_id=$1 AND turn_id=$2',
            [
              sessionId,
              (event.payload as { revertedTurnId: string }).revertedTurnId,
            ],
          );
      const revertedTurnIds = [
        ...new Set([
          ...events
            .filter((event) => event.type === 'TurnReverted')
            .map(
              (event) =>
                (event.payload as { revertedTurnId: string }).revertedTurnId,
            ),
          ...rewoundTurnIds,
        ]),
      ];
      if (revertedTurnIds.length) {
        const blocked = await client.query(
          `SELECT 1 FROM registry_entries s
             JOIN registry_entries d ON d.id = s.supersedes_id
            WHERE d.session_id = $1 AND d.turn_id = ANY($2::text[])
              AND (s.turn_id IS NULL OR s.turn_id <> ALL($2::text[]))
            LIMIT 1`,
          [sessionId, revertedTurnIds],
        );
        if (blocked.rowCount)
          throw new RewindRefusedError(
            'Rewind refused: a registry entry outside the rewound turns supersedes a version this rewind would remove.',
          );
        await new RegistryMemory(this.pool).removeTurnsInTransaction(
          client,
          sessionId,
          revertedTurnIds,
        );
      }
      const snapshot = await insertSnapshot(client, sessionId, last.seq, state);
      return { events: inserted, snapshot };
    });
  }

  async isAccountActive(accountId: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      "SELECT 1 FROM accounts WHERE id=$1 AND status='active'",
      [accountId],
    );
    return rowCount === 1;
  }

  async matureEligibleAccounts(accountIds: string[]): Promise<string[]> {
    const { rows } = await this.pool.query<{ id: string }>(
      `SELECT id::text AS id FROM accounts
        WHERE id = ANY($1::uuid[]) AND status='active' AND mature_opt_out=false`,
      [accountIds],
    );
    return rows.map((row) => row.id);
  }

  /** Log window that restores the room to just before its last resolved DM turn. */
  async loadRewindPlan(sessionId: string): Promise<RewindPlan | null> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const log = await client.query<{
        seq: string;
        turn_id: string;
        type: string;
        payload: unknown;
      }>(
        `SELECT seq, turn_id, type, CASE WHEN type = 'TurnReverted' THEN payload END AS payload
           FROM events WHERE session_id = $1 ORDER BY seq`,
        [sessionId],
      );
      const target = findRewindTarget(
        log.rows.map((row) => ({
          seq: Number(row.seq),
          turnId: row.turn_id,
          type: row.type,
          payload: row.payload,
        })),
      );
      if (!target) {
        await client.query('COMMIT');
        return null;
      }
      const snapshots = await client.query<{
        seq: string;
        state: unknown;
        created_at: Date;
      }>(
        'SELECT seq, state, created_at FROM snapshots WHERE session_id = $1 AND seq < $2 ORDER BY seq DESC LIMIT 1',
        [sessionId, target.firstSeq],
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
        'SELECT seq,turn_id,type,payload,ts FROM events WHERE session_id = $1 AND seq > $2 AND seq < $3 ORDER BY seq',
        [sessionId, snapshot?.seq ?? 0, target.firstSeq],
      );
      const retained = await client.query<{
        seq: string;
        turn_id: string;
        type: string;
        payload: unknown;
        ts: Date;
      }>(
        `SELECT seq,turn_id,type,payload,ts FROM events
          WHERE session_id = $1 AND seq > $2 AND turn_id::text <> $3 AND type = ANY($4::text[])
            AND ${REVERTED_TURN_EXCLUSION}
          ORDER BY seq`,
        [sessionId, target.firstSeq, target.turnId, ROOM_STATE_EVENT_TYPES],
      );
      await client.query('COMMIT');
      const retainedSeqs = new Set(retained.rows.map((row) => Number(row.seq)));
      const droppedTurnIds = [
        ...new Set(
          log.rows
            .filter(
              (row) =>
                Number(row.seq) >= target.firstSeq &&
                !retainedSeqs.has(Number(row.seq)),
            )
            .flatMap((row) =>
              row.type === 'TurnReverted'
                ? [
                    row.turn_id,
                    (row.payload as { revertedTurnId: string }).revertedTurnId,
                  ]
                : [row.turn_id],
            ),
        ),
      ];
      const toStored = (row: (typeof tail.rows)[number]): StoredEvent => ({
        sessionId,
        seq: Number(row.seq),
        turnId: row.turn_id,
        type: row.type,
        payload: row.payload,
        ts: row.ts,
      });
      return {
        turnId: target.turnId,
        rewindUsed: target.rewindUsed,
        before: { snapshot, events: tail.rows.map(toStored) },
        retained: retained.rows.map(toStored),
        headSeq: Number(log.rows.at(-1)?.seq ?? 0),
        droppedTurnIds,
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
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
