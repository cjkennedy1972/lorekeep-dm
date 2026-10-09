import { randomUUID } from 'node:crypto';
import {
  RoomStateSchema,
  type RoomState,
  type ServerMessage,
} from '@game/schema';
import { RegistryMemory, type RegistryEvent } from '../dm/memory.js';
import type { Pool } from 'pg';
import type {
  EventInput,
  LatestState,
  StoredEvent,
} from '../persistence/index.js';
import type { Lease } from './lease.js';
import { recoverRoom } from './recovery.js';
import { reduceRoom } from './reducer.js';
import type { SoloTurnRunner } from './dmTurn.js';

export interface RoomStore {
  loadLatest(sessionId: string): Promise<LatestState>;
  db?: Pick<Pool, 'query' | 'connect'>;
  persistRegistryEvents?(
    sessionId: string,
    events: readonly RegistryEvent[],
    lease: Lease,
  ): Promise<void>;
  writeTurn(
    sessionId: string,
    events: readonly EventInput[],
    state: unknown,
    lease: Lease,
    registryEvents?: readonly RegistryEvent[],
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
  private readonly turnRunner?: SoloTurnRunner;
  private turnInFlight = false;
  private readonly pendingActions = new Set<string>();
  private activeTurn: Promise<void> = Promise.resolve();
  private readonly queuedActions: {
    accountId: string;
    actionId: string;
    text: string;
    playerName: string;
  }[] = [];
  readonly sessionId: string;
  state: RoomState;
  seq: number;

  constructor(
    private readonly store: RoomStore,
    readonly lease: Lease,
    latest: LatestState,
    turnRunner?: SoloTurnRunner,
  ) {
    if (!lease || lease.expiresAt <= new Date())
      throw new Error('Room requires a live lease');
    this.sessionId = lease.sessionId;
    this.turnRunner = turnRunner;
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
  /** Persist initial or lifecycle game metadata in a lease-fenced room snapshot. */
  persistGameState(gameState: unknown): Promise<void> {
    return this.enqueue(async () => {
      const nextState = RoomStateSchema.parse({ ...this.state, gameState });
      const stored = await this.store.writeTurn(
        this.sessionId,
        [
          {
            seq: this.seq + 1,
            turnId: randomUUID(),
            type: 'GameStateCommitted',
            payload: { gameState },
          },
        ],
        nextState,
        this.lease,
      );
      this.seq = stored.events.at(-1)?.seq ?? this.seq + 1;
      this.state = nextState;
    });
  }

  persistRecap(recap: { recap: string; memoryHash: string }): Promise<void> {
    return this.enqueue(async () => {
      const gameState = {
        ...((this.state.gameState as Record<string, unknown>) ?? {}),
        recap,
      };
      const nextState = RoomStateSchema.parse({ ...this.state, gameState });
      const stored = await this.store.writeTurn(
        this.sessionId,
        [
          {
            seq: this.seq + 1,
            turnId: randomUUID(),
            type: 'GameStateCommitted',
            payload: { gameState },
          },
        ],
        nextState,
        this.lease,
      );
      this.seq = stored.events.at(-1)?.seq ?? this.seq + 1;
      this.state = nextState;
    });
  }

  /** Persist validated registry tool events through the room actor and lease-fenced store. */
  persistRegistry(events: readonly RegistryEvent[]): Promise<void> {
    return this.enqueue(async () => {
      if (!this.store.persistRegistryEvents)
        throw new Error('Room store does not support registry persistence');
      await this.store.persistRegistryEvents(
        this.sessionId,
        events,
        this.lease,
      );
    });
  }

  submit(actionId: string): Promise<boolean> {
    return this.enqueue(async () => {
      if (this.actionIds.has(actionId) || this.pendingActions.has(actionId))
        return false;
      await this.persist('ActionAccepted', { actionId });
      this.actionIds.add(actionId);
      return true;
    });
  }

  submitAction(
    accountId: string,
    actionId: string,
    text: string,
    playerName?: string,
  ): Promise<boolean> {
    return this.enqueue(async () => {
      const seat = this.state.seats.find(
        (item) => item.accountId === accountId,
      );
      if (!seat) throw new Error('Account is not seated');
      if (!this.turnRunner) throw new Error('Solo turn runner unavailable');
      if (this.actionIds.has(actionId) || this.pendingActions.has(actionId))
        return false;
      this.pendingActions.add(actionId);
      this.broadcast({
        seq: this.seq,
        type: 'ActionQueued',
        payload: { actionId },
      } as ServerMessage);
      this.queuedActions.push({
        accountId,
        actionId,
        text,
        playerName: playerName ?? seat.displayName,
      });
      if (!this.turnInFlight) {
        this.turnInFlight = true;
        this.activeTurn = this.resolveQueuedTurns();
        void this.activeTurn.catch(() => undefined);
      }
      return true;
    });
  }

  private async resolveQueuedTurns(): Promise<void> {
    while (this.queuedActions.length > 0) {
      const action = this.queuedActions.shift();
      if (!action) continue;
      this.broadcast({
        seq: this.seq,
        type: 'TurnThinking',
        payload: { actionId: action.actionId },
      } as ServerMessage);
      try {
        await this.resolveTurn(
          action.accountId,
          action.actionId,
          action.text,
          action.playerName,
        );
      } catch {
        // A turn that throws (e.g. no endpoint configured, table state unavailable) must not
        // leave the player waiting forever. Nothing was committed, so the same action can be
        // resubmitted. The message is deliberately generic: no error text, prompt or secret.
        this.pendingActions.delete(action.actionId);
        this.broadcast({
          seq: this.seq,
          type: 'Error',
          payload: {
            code: 'TURN_FAILED',
            message: 'The DM could not complete that turn. You can try again.',
            actionId: action.actionId,
          },
        } as ServerMessage);
      }
    }
    this.turnInFlight = false;
  }

  private async resolveTurn(
    accountId: string,
    actionId: string,
    text: string,
    playerName: string,
  ): Promise<void> {
    const result = await this.turnRunner!.run(
      {
        sessionId: this.sessionId,
        accountId,
        actionId,
        text,
        state: this.state.gameState ?? this.state,
        playerName,
      },
      (event) => {
        const type = event.type;
        if (type === 'RollEvent') {
          this.broadcast({
            seq: this.seq,
            type: 'RollEvent',
            payload: event,
          } as ServerMessage);
        } else if (type === 'NarrationChunk' || type === 'NarrationCompleted') {
          this.broadcast({
            seq: this.seq,
            type,
            payload: event,
          } as ServerMessage);
        } else if (type === 'ToolCallRejected') {
          this.broadcast({
            seq: this.seq,
            type: 'ToolRejected',
            payload: { turnId: event.turnId },
          } as ServerMessage);
        }
      },
    );
    // Endpoint fallback invalidates all partial engine effects; only successful results are saved.
    if (result.fallback !== 'endpoint-error') {
      const turnId = result.events.find(
        (event) => (event as { type?: string }).type === 'TurnStarted',
      ) as { turnId?: string } | undefined;
      const id = turnId?.turnId ?? actionId;
      const registryEvents = result.events.filter(
        (event): event is RegistryEvent =>
          !!event &&
          typeof event === 'object' &&
          [
            'NpcUpserted',
            'LocationUpserted',
            'QuestUpdated',
            'FlagSet',
            'RulingLogged',
          ].includes(String((event as { type?: unknown }).type)),
      );
      const writes = result.events
        .filter((event) => {
          const type = String((event as { type?: string }).type);
          return (
            type !== 'TurnStarted' &&
            !type.startsWith('Narration') &&
            !type.startsWith('Prompt') &&
            !type.startsWith('ToolCall')
          );
        })
        .map((event) => ({
          seq: undefined,
          turnId: id,
          type: String((event as { type: string }).type),
          payload: event,
        }));
      writes.push({
        seq: undefined,
        turnId: id,
        type: 'NarrationCompleted',
        payload: { actionId, narration: result.narration },
      });
      writes.push({
        seq: undefined,
        turnId: id,
        type: 'ActionAccepted',
        payload: { actionId },
      });
      const nextSeq = this.seq + writes.length;
      const committedGameState = result.state as {
        gameEngine?: unknown;
        characters?: unknown;
      };
      const nextState = {
        ...this.state,
        gameState:
          committedGameState && typeof committedGameState === 'object'
            ? {
                ...(this.state.gameState &&
                typeof this.state.gameState === 'object'
                  ? this.state.gameState
                  : {}),
                ...committedGameState,
              }
            : result.state,
      } as RoomState;
      writes.push({
        seq: undefined,
        turnId: id,
        type: 'GameStateCommitted',
        payload: { gameState: nextState.gameState },
      });
      const snapshotState = {
        ...nextState,
        actionIds: [...this.actionIds, actionId],
      };
      const stored = await this.store.writeTurn(
        this.sessionId,
        writes,
        snapshotState,
        this.lease,
        registryEvents,
      );
      this.seq = stored.events.at(-1)?.seq ?? nextSeq;
      this.state = nextState;
      this.actionIds.add(actionId);
    }
    this.pendingActions.delete(actionId);
  }
  private broadcast(message: ServerMessage): void {
    for (const connection of this.connections.values())
      connection.send(message);
  }
  async drain(): Promise<void> {
    this.accepting = false;
    await this.mailbox;
    await this.activeTurn;
    this.connections.clear();
  }
}
