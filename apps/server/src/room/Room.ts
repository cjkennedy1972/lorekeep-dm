import { randomUUID } from 'node:crypto';
import {
  RoomStateSchema,
  type RoomState,
  type ServerMessage,
} from '@game/schema';
import type { RegistryEvent } from '../dm/memory.js';
import type {
  EventInput,
  LatestState,
  StoredEvent,
} from '../persistence/index.js';
import type { Lease } from './lease.js';
import { recoverRoom } from './recovery.js';
import { reduceRoom } from './reducer.js';
import type { SoloTurnRunner } from './dmTurn.js';
import type { CombatCommand } from '@game/schema';
import {
  createCombatRuntime,
  roomGameState,
  toWireEvent,
  trackerMessage,
  reactionMessage,
  type CombatRuntime,
  type CombatTransition,
} from './combat.js';
import { settleEngine } from './combatBootstrap.js';
import type { ActionId } from '@game/schema';
import { loadCatalog } from '@game/rules-engine/room-tools';
import type { Catalog } from '@game/rules-engine';
import { resolveSoloRest } from './rest.js';
import { failForward, resolveDeathSave, retryFromCheckpoint } from './death.js';

const MAX_QUEUED_ACTIONS_PER_SEAT = 3;
const MAX_QUEUED_ACTIONS_PER_ROOM = 12;

export interface RoomStore {
  loadLatest(sessionId: string): Promise<LatestState>;
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
  private readonly combatRuntime: CombatRuntime;
  private reactionTimer?: NodeJS.Timeout;
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
    combatRuntime: CombatRuntime = createCombatRuntime(),
  ) {
    if (!lease || lease.expiresAt <= new Date())
      throw new Error('Room requires a live lease');
    this.sessionId = lease.sessionId;
    this.turnRunner = turnRunner;
    this.combatRuntime = combatRuntime;
    const recovered = recoverRoom(this.sessionId, latest);
    this.state = recovered.state;
    this.seq = recovered.seq;
    this.actionIds = recovered.actionIds;
    // A restart mid-prompt resumes the countdown from the persisted deadline.
    this.scheduleReaction();
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
      this.sendCombatSnapshot(connection);
    });
  }

  /** A (re)connecting client gets the tracker and any open reaction prompt with its remaining time. */
  private sendCombatSnapshot(connection: Connection): void {
    const combat = roomGameState(this.state);
    if (!combat) return;
    connection.send(trackerMessage(this.seq, combat));
    if (combat.pendingReaction)
      connection.send(reactionMessage(this.seq, combat.pendingReaction));
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
      this.sendCombatSnapshot(connection);
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

  /** Save the explicit recovery point used if the solo character dies. */
  saveCheckpoint(): Promise<void> {
    return this.enqueue(async () => {
      const gameState = this.state.gameState as
        | Record<string, unknown>
        | undefined;
      if (!gameState) throw new Error('Game state is unavailable');
      await this.commitGameState(
        { ...gameState, checkpoint: structuredClone(gameState) },
        [{ type: 'CheckpointSaved' }],
      );
    });
  }

  takeRest(
    accountId: string,
    kind: 'short' | 'long',
    hitDiceToSpend = 1,
    interruptionChance = 0,
    catalog: Catalog = loadCatalog(),
  ): Promise<void> {
    return this.enqueue(async () => {
      if (!this.state.seats.some((seat) => seat.accountId === accountId))
        throw new Error('Account is not seated');
      const gameState = this.state.gameState as
        | Record<string, unknown>
        | undefined;
      if (!gameState) throw new Error('Game state is unavailable');
      const resolved = resolveSoloRest(
        gameState,
        accountId,
        kind,
        catalog,
        hitDiceToSpend,
        interruptionChance,
      );
      await this.commitGameState(resolved.gameState, resolved.events);
    });
  }

  rollDeathSave(accountId: string): Promise<void> {
    return this.enqueue(async () => {
      if (!this.state.seats.some((seat) => seat.accountId === accountId))
        throw new Error('Account is not seated');
      const gameState = this.state.gameState as
        | Record<string, unknown>
        | undefined;
      if (!gameState) throw new Error('Game state is unavailable');
      const resolved = resolveDeathSave(gameState, accountId);
      await this.commitGameState(resolved.gameState, resolved.events);
      if (resolved.prompt === 'tpk-choice')
        this.broadcast({
          seq: this.seq,
          type: 'TpkChoiceRequired',
          payload: {
            accountId,
            options: [
              'retry-checkpoint',
              'fail-forward',
              'resurrection-or-new-character',
            ],
          },
        } as ServerMessage);
      else if (resolved.prompt === 'death-save')
        this.broadcast({
          seq: this.seq,
          type: 'DeathSaveRequired',
          payload: { accountId },
        } as ServerMessage);
    });
  }

  chooseTpkResolution(
    accountId: string,
    choice:
      | 'retry-checkpoint'
      | 'fail-forward'
      | 'resurrection-or-new-character',
    narrative?: string,
  ): Promise<void> {
    return this.enqueue(async () => {
      if (!this.state.seats.some((seat) => seat.accountId === accountId))
        throw new Error('Account is not seated');
      const gameState = this.state.gameState as
        | Record<string, unknown>
        | undefined;
      if (!gameState) throw new Error('Game state is unavailable');
      if (choice === 'retry-checkpoint') {
        const checkpoint = gameState.checkpoint;
        if (!checkpoint || typeof checkpoint !== 'object')
          throw new Error('No checkpoint is available');
        const oldSeed = Number(
          gameState.retrySeed ??
            (gameState.gameEngine as { seed?: number } | undefined)?.seed ??
            0,
        );
        const restored = retryFromCheckpoint(
          checkpoint as Record<string, unknown>,
          oldSeed,
        );
        await this.commitGameState(
          {
            ...restored,
            checkpoint,
            retrySeed: restored.seed,
            characterChoice: undefined,
          },
          [
            {
              type: 'CheckpointRetried',
              previousSeed: oldSeed,
              seed: restored.seed,
            },
          ],
        );
      } else if (choice === 'fail-forward') {
        if (!narrative)
          throw new Error('Fail-forward requires a narrative choice');
        const result = failForward(gameState, accountId, narrative);
        await this.commitGameState(result.gameState, result.events);
      } else {
        await this.commitGameState(
          { ...gameState, characterChoice: { accountId, choice } },
          [{ type: 'ResurrectionOrNewCharacterOffered', accountId }],
        );
      }
    });
  }

  private async commitGameState(
    gameState: unknown,
    events: readonly Record<string, unknown>[],
  ): Promise<void> {
    const parsed = RoomStateSchema.parse({ ...this.state, gameState });
    const turnId = randomUUID();
    const writes = [
      ...events.map((event) => ({
        seq: undefined,
        turnId,
        type: String(event.type),
        payload: event,
      })),
      {
        seq: undefined,
        turnId,
        type: 'GameStateCommitted',
        payload: { gameState },
      },
    ];
    const stored = await this.store.writeTurn(
      this.sessionId,
      writes,
      parsed,
      this.lease,
    );
    this.seq = stored.events.at(-1)?.seq ?? this.seq;
    this.state = parsed;
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
      const queuedForSeat =
        this.queuedActions.filter((action) => action.accountId === accountId)
          .length + (this.turnInFlight ? 1 : 0);
      if (
        queuedForSeat >= MAX_QUEUED_ACTIONS_PER_SEAT ||
        this.queuedActions.length + (this.turnInFlight ? 1 : 0) >=
          MAX_QUEUED_ACTIONS_PER_ROOM
      ) {
        throw new Error('ACTION_REJECTED');
      }
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

  withdrawAction(accountId: string, actionId: string): Promise<boolean> {
    return this.enqueue(async () => {
      const index = this.queuedActions.findIndex(
        (action) =>
          action.accountId === accountId && action.actionId === actionId,
      );
      if (index === -1) return false;
      this.queuedActions.splice(index, 1);
      this.pendingActions.delete(actionId);
      this.broadcast({
        seq: this.seq,
        type: 'ActionWithdrawn',
        payload: { actionId },
      } as ServerMessage);
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
    const startCombat = JSON.stringify(roomGameState(this.state) ?? null);
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
    // Commit inside the mailbox so a combat command or reaction timeout cannot interleave with it.
    await this.enqueue(async () => {
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
        let incoming = (
          result.state && typeof result.state === 'object' ? result.state : {}
        ) as Record<string, unknown>;
        const live = this.state.gameState as
          | Record<string, unknown>
          | undefined;
        // Combat that moved on while the DM was narrating is owned by the Room, not by the turn.
        if (live && JSON.stringify(live.combatRoom ?? null) !== startCombat)
          incoming = {
            ...incoming,
            combatRoom: live.combatRoom,
            combatActors: live.combatActors,
            characters: live.characters,
            gameEngine: live.gameEngine,
          };
        const reconciled = this.combatRuntime.reconcile(incoming, Date.now());
        const combatEvents = reconciled?.events ?? [];
        const turnGameState = reconciled?.gameState ?? incoming;
        for (const event of combatEvents)
          writes.push({
            seq: undefined,
            turnId: id,
            type: String(event.type),
            payload: event,
          });
        const nextState = {
          ...this.state,
          gameState: settleEngine(turnGameState),
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
        const room = roomGameState(nextState);
        if (room && combatEvents.length)
          this.announceCombat(room, combatEvents, accountId);
      }
      this.pendingActions.delete(actionId);
    });
  }
  submitCombatCommand(
    accountId: string,
    actionId: string,
    command: CombatCommand['payload'],
  ): Promise<boolean> {
    return this.enqueue(async () => {
      const seat = this.state.seats.find(
        (item) => item.accountId === accountId,
      );
      if (!seat) throw new Error('Account is not seated');
      if (this.actionIds.has(actionId)) return false;
      const current = roomGameState(this.state);
      const gameState = this.state.gameState as
        | {
            combatActors?: Record<string, string>;
            characters?: Record<string, never>;
          }
        | undefined;
      const actorId = gameState?.combatActors?.[accountId];
      if (!current || !actorId) {
        this.sendError(
          accountId,
          'COMMAND_REJECTED',
          'Combat is not active for this player.',
          actionId,
        );
        return true;
      }
      if (this.turnInFlight) {
        this.sendError(
          accountId,
          'COMMAND_REJECTED',
          'The DM is still narrating; try again in a moment.',
          actionId,
        );
        return true;
      }
      const result = this.combatRuntime.execute(current, actorId, command, {
        character: gameState?.characters?.[accountId],
        now: Date.now(),
      });
      if ('code' in result) {
        this.sendError(accountId, result.code, result.message, actionId);
        return true;
      }
      if (!result.events.length && !result.state.pendingReaction) {
        for (const message of result.messages ?? [])
          this.connections.get(accountId)?.send({
            seq: this.seq,
            type: message.type,
            payload: message.payload,
          } as ServerMessage);
        return true;
      }
      await this.commitCombat(actionId, result, accountId, actionId);
      return true;
    });
  }

  /** Persist a combat transition atomically with its snapshot, then tell the table. */
  private async commitCombat(
    turnId: string,
    result: CombatTransition,
    accountId: string | undefined,
    actionId?: string,
  ): Promise<void> {
    const gameState = settleEngine(
      {
        ...(this.state.gameState as Record<string, unknown> | undefined),
        combatRoom: result.state,
      },
      result.slots,
    );
    const writes = result.events.map((event) => ({
      seq: undefined,
      turnId,
      type: String(event.type),
      payload: event,
    }));
    writes.push({
      seq: undefined,
      turnId,
      type: 'GameStateCommitted',
      payload: { gameState },
    });
    const actionIds = actionId
      ? [...this.actionIds, actionId]
      : [...this.actionIds];
    const stored = await this.store.writeTurn(
      this.sessionId,
      writes,
      { ...this.state, gameState, actionIds },
      this.lease,
    );
    this.seq = stored.events.at(-1)?.seq ?? this.seq;
    this.state = { ...this.state, gameState } as RoomState;
    if (actionId) this.actionIds.add(actionId);
    this.announceCombat(result.state, result.events, accountId);
  }

  /** Broadcast what changed, arm the reaction deadline and queue the DM's narration. */
  private announceCombat(
    state: NonNullable<ReturnType<typeof roomGameState>>,
    events: readonly Record<string, unknown>[],
    accountId: string | undefined,
  ): void {
    if (events.length)
      this.broadcast({
        seq: this.seq,
        type: 'CombatEvents',
        payload: { events: events.map(toWireEvent) },
      } as ServerMessage);
    const ended = events.find((event) => event.type === 'CombatEnded');
    if (ended)
      this.broadcast({
        seq: this.seq,
        type: 'CombatEnded',
        payload: { outcome: ended.outcome },
      } as ServerMessage);
    this.broadcast(trackerMessage(this.seq, state));
    if (state.pendingReaction)
      this.broadcast(reactionMessage(this.seq, state.pendingReaction));
    this.scheduleReaction();
    const narrate = events.some((event) =>
      ['MonsterPolicy', 'CombatEnded', 'ReactionResolved'].includes(
        String(event.type),
      ),
    );
    if (narrate && this.turnRunner) this.queueNarration(events, accountId);
  }

  /** The DM narrates what the engine already decided; it never decides outcomes. */
  private queueNarration(
    events: readonly Record<string, unknown>[],
    accountId: string | undefined,
  ): void {
    const owner =
      accountId ??
      this.state.seats.find((seat) => seat.accountId)?.accountId ??
      undefined;
    if (!owner) return;
    const facts = events
      .filter((event) =>
        [
          'HpChanged',
          'EntityMoved',
          'CombatEnded',
          'ReactionResolved',
        ].includes(String(event.type)),
      )
      .slice(0, 12)
      .map((event) => JSON.stringify(event));
    const actionId = randomUUID();
    this.pendingActions.add(actionId);
    this.queuedActions.push({
      accountId: owner,
      actionId,
      text: `[Combat resolved by the engine; narrate it, do not change it] ${facts.join(' ')}`,
      playerName: 'Combat',
    });
    if (!this.turnInFlight) {
      this.turnInFlight = true;
      this.activeTurn = this.resolveQueuedTurns();
      void this.activeTurn.catch(() => undefined);
    }
  }

  private scheduleReaction(): void {
    clearTimeout(this.reactionTimer);
    this.reactionTimer = undefined;
    const prompt = roomGameState(this.state)?.pendingReaction;
    if (!prompt || !this.accepting) return;
    this.reactionTimer = setTimeout(
      () => {
        this.reactionTimer = undefined;
        void this.enqueue(() => this.declineExpiredReaction()).catch(
          () => undefined,
        );
      },
      Math.max(0, prompt.deadlineAt - Date.now()),
    );
    this.reactionTimer.unref?.();
  }

  private async declineExpiredReaction(): Promise<void> {
    const current = roomGameState(this.state);
    if (!current?.pendingReaction) return;
    const result = this.combatRuntime.expire(current, Date.now());
    if (!result) return this.scheduleReaction();
    await this.commitCombat(randomUUID(), result, undefined);
  }

  private sendError(
    accountId: string,
    code: string,
    message: string,
    actionId: string,
  ): void {
    this.connections.get(accountId)?.send({
      seq: this.seq,
      type: 'Error',
      payload: { code, message, actionId: actionId as ActionId },
    });
  }

  private broadcast(message: ServerMessage): void {
    for (const connection of this.connections.values())
      connection.send(message);
  }
  async drain(): Promise<void> {
    this.accepting = false;
    clearTimeout(this.reactionTimer);
    await this.mailbox;
    await this.activeTurn;
    this.connections.clear();
  }
}
