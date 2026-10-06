import { randomUUID } from 'node:crypto';
import type { RoomState, ServerMessage } from '@game/schema';
import type {
  EventInput,
  LatestState,
  StoredEvent,
} from '../persistence/index.js';
import type { Lease } from './lease.js';
import { recoverRoom } from './recovery.js';
import { reduceRoom } from './reducer.js';

export interface RoomStore {
  loadLatest(sessionId: string): Promise<LatestState>;
  writeTurn(
    sessionId: string,
    events: readonly EventInput[],
    state: unknown,
    lease: Lease,
  ): Promise<{ events: StoredEvent[] }>;
}
export interface Connection {
  send(message: ServerMessage): void;
}

export class Room {
  private mailbox: Promise<unknown> = Promise.resolve();
  private readonly connections = new Map<string, Connection>();
  private readonly actionIds: Set<string>;
  private accepting = true;
  readonly sessionId: string;
  state: RoomState;
  seq: number;

  constructor(
    private readonly store: RoomStore,
    readonly lease: Lease,
    latest: LatestState,
  ) {
    if (!lease || lease.expiresAt <= new Date())
      throw new Error('Room requires a live lease');
    this.sessionId = lease.sessionId;
    const recovered = recoverRoom(this.sessionId, latest);
    this.state = recovered.state;
    this.seq = recovered.seq;
    this.actionIds = recovered.actionIds;
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    if (!this.accepting) return Promise.reject(new Error('Room is draining'));
    const result = this.mailbox.then(work);
    this.mailbox = result.catch(() => undefined);
    return result;
  }

  private async persist(type: string, payload: unknown): Promise<StoredEvent> {
    const next = this.seq + 1;
    const event: StoredEvent = {
      sessionId: this.sessionId,
      seq: next,
      turnId: randomUUID(),
      type,
      payload,
      ts: new Date(),
    };
    const state = reduceRoom(this.state, event);
    const actionIds =
      type === 'ActionAccepted'
        ? [...this.actionIds, (payload as { actionId: string }).actionId]
        : [...this.actionIds];
    const stored = await this.store.writeTurn(
      this.sessionId,
      [{ seq: next, turnId: event.turnId, type, payload }],
      { ...state, actionIds },
      this.lease,
    );
    const committed = stored.events[0];
    if (!committed) throw new Error('Persistence returned no event');
    this.seq = committed.seq;
    this.state = state;
    return committed;
  }

  subscribe(
    accountId: string,
    connection: Connection,
    lastSeq = -1,
  ): Promise<void> {
    return this.enqueue(async () => {
      this.connections.set(accountId, connection);
      if (lastSeq !== this.seq)
        connection.send({
          seq: this.seq,
          type: 'StateSync',
          payload: { state: this.state },
        });
    });
  }

  join(
    accountId: string,
    connection: Connection,
    displayName = accountId,
    lastSeq = -1,
  ): Promise<void> {
    return this.enqueue(async () => {
      let seat = this.state.seats.find((item) => item.accountId === accountId);
      if (!seat) {
        if (this.state.seats.length >= 6) throw new Error('Room is full');
        seat = {
          seatId: randomUUID() as RoomState['seats'][number]['seatId'],
          accountId: accountId as RoomState['seats'][number]['accountId'],
          displayName,
          presence: 'offline',
        };
        await this.persist('SeatJoined', seat);
        this.broadcast({
          seq: this.seq,
          type: 'StateSync',
          payload: { state: this.state },
        });
      }
      this.connections.set(accountId, connection);
      if (lastSeq !== this.seq)
        connection.send({
          seq: this.seq,
          type: 'StateSync',
          payload: { state: this.state },
        });
      if (seat.presence !== 'online') {
        const event = await this.persist('PresenceChanged', {
          seatId: seat.seatId,
          presence: 'online',
        });
        this.broadcast({
          seq: event.seq,
          type: 'PresenceChanged',
          payload: { seatId: seat.seatId, presence: 'online' },
        });
      }
    });
  }

  /** Seat an account without a socket; idempotent, atomic against the 6-seat cap via the actor mailbox. */
  seat(accountId: string, displayName: string): Promise<void> {
    return this.enqueue(async () => {
      if (this.state.seats.some((item) => item.accountId === accountId)) return;
      if (this.state.seats.length >= 6) throw new Error('Room is full');
      await this.persist('SeatJoined', {
        seatId: randomUUID(),
        accountId,
        displayName,
        presence: 'offline',
      });
      this.broadcast({
        seq: this.seq,
        type: 'StateSync',
        payload: { state: this.state },
      });
    });
  }

  isCurrentConnection(accountId: string, connection: Connection): boolean {
    return this.connections.get(accountId) === connection;
  }

  get connectionCount(): number {
    return this.connections.size;
  }

  leave(accountId: string): Promise<void> {
    return this.disconnect(accountId);
  }
  disconnect(accountId: string): Promise<void> {
    return this.enqueue(async () => {
      this.connections.delete(accountId);
      const seat = this.state.seats.find(
        (item) => item.accountId === accountId,
      );
      if (seat?.presence === 'online') {
        const event = await this.persist('PresenceChanged', {
          seatId: seat.seatId,
          presence: 'offline',
        });
        this.broadcast({
          seq: event.seq,
          type: 'PresenceChanged',
          payload: { seatId: seat.seatId, presence: 'offline' },
        });
      }
    });
  }
  submit(actionId: string): Promise<boolean> {
    return this.enqueue(async () => {
      if (this.actionIds.has(actionId)) return false;
      await this.persist('ActionAccepted', { actionId });
      this.actionIds.add(actionId);
      return true;
    });
  }
  private broadcast(message: ServerMessage): void {
    for (const connection of this.connections.values())
      connection.send(message);
  }
  async drain(): Promise<void> {
    this.accepting = false;
    await this.mailbox;
    this.connections.clear();
  }
}
