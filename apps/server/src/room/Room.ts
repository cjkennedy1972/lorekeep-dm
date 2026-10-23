import { randomUUID } from 'node:crypto';
import {
  RoomStateSchema,
  TurnRevertedSchema,
  type ChatHistoryEntry,
  type RoomState,
  type ServerMessage,
  type ChatMessage,
} from '@game/schema';
import type { RegistryEvent } from '../dm/memory.js';
import {
  ChatSeatRevokedError,
  LeaseConflictError,
  RewindRefusedError,
  type EventInput,
  type LatestState,
  type RewindPlan,
  type StoredEvent,
} from '../persistence/index.js';
import type { HostCap } from '../safety/tier.js';
import type { Lease } from './lease.js';
import { recoverRoom } from './recovery.js';
import { reduceRoom } from './reducer.js';
import {
  LiveDmRestrictedError,
  XCardAbortError,
  type SoloTurnRunner,
} from './dmTurn.js';
import type { CombatCommand } from '@game/schema';
import {
  createCombatRuntime,
  roomGameState,
  toWireEvent,
  trackerMessage,
  reactionMessage,
  type CombatRuntime,
  type CombatTransition,
  type RoomCombatState,
} from './combat.js';
import { settleEngine } from './combatBootstrap.js';
import { withHp } from './combatEngine.js';
import type { ActionId } from '@game/schema';
import { loadCatalog } from '@game/rules-engine/room-tools';
import type { Catalog } from '@game/rules-engine';
import { resolveSoloRest } from './rest.js';
import { failForward, resolveDeathSave, retryFromCheckpoint } from './death.js';

const CLIENT_GAME_STATE_FIELDS = ['characters', 'combatRoom'] as const;

function clientGameState(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const source = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const key of CLIENT_GAME_STATE_FIELDS)
    if (key in source) result[key] = source[key];
  if (source.checkpoint && typeof source.checkpoint === 'object')
    result.checkpoint = clientGameState(source.checkpoint);
  return result;
}

const MAX_QUEUED_ACTIONS_PER_SEAT = 3;
const MAX_QUEUED_ACTIONS_PER_ROOM = 12;

function publicRoundSubmission(
  submission: NonNullable<RoomState['round']>['submissions'][number],
) {
  return {
    seatId: submission.seatId,
    actionId: submission.actionId,
    originalActionId: submission.originalActionId,
    actionIds: submission.actionIds,
    playerName: submission.playerName,
    receiptSeq: submission.receiptSeq,
    ...(submission.editedAt !== undefined
      ? { editedAt: submission.editedAt }
      : {}),
  };
}

type GatedRoundMutation =
  | {
      kind: 'submit';
      accountId: string;
      actionId: string;
      text: string;
      playerName: string;
    }
  | {
      kind: 'edit';
      accountId: string;
      actionId: string;
      editedActionId: string;
      text: string;
    };

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
    expectedHeadSeq?: number,
    registryTurnId?: string,
    rewoundTurnIds?: readonly string[],
  ): Promise<{ events: StoredEvent[] }>;
  writeHostTierCap(
    sessionId: string,
    cap: HostCap | null,
    lease: Lease,
    seq: number,
  ): Promise<StoredEvent[]>;
  writeChat?(
    sessionId: string,
    event: EventInput,
    lease: Lease,
  ): Promise<StoredEvent>;
  loadChatHistory?(
    sessionId: string,
    limit?: number,
  ): Promise<ChatHistoryEntry[]>;
  /** Accounts among these that are active and not opted out of mature content. */
  matureEligibleAccounts?(accountIds: string[]): Promise<string[]>;
  loadRewindPlan?(sessionId: string): Promise<RewindPlan | null>;
  isTableHost?(sessionId: string, accountId: string): Promise<boolean>;
  /** Host setting: abort an in-flight generation when an X-card is pressed. Off unless the host enabled it. */
  xCardAbortEnabled?(sessionId: string): Promise<boolean>;
  setXCardAbortEnabled?(sessionId: string, enabled: boolean): Promise<void>;
}

export interface ChatReceipt {
  readonly receiptSeq: number;
  readonly receivedAt: number;
  readonly previous: Promise<void>;
  readonly decision?: string;
  decide(reason: string): boolean;
  readonly finish: () => void;
}
export interface Connection {
  send(message: ServerMessage): void;
  close?(code: number, reason: string): void;
}

export const CLARIFICATION_TIMEOUT_MS = 10 * 60_000;
const DRAIN_DEADLINE_MS = 30_000;
const DEFAULT_ROUND_MS = 120_000;
const ROUND_GATE_GRACE_MS = 5_000;

export { RewindRefusedError };

export class NotTableHostError extends Error {
  constructor(message = 'Only the table host can resume') {
    super(message);
    this.name = 'NotTableHostError';
  }
}

export class RoomPausedError extends Error {
  constructor() {
    super('Resolve now is unavailable while the table is paused');
    this.name = 'RoomPausedError';
  }
}

export class RoomSeatRequiredError extends Error {
  constructor() {
    super('Player is not seated at this table');
    this.name = 'RoomSeatRequiredError';
  }
}

export class Room {
  private mailbox: Promise<unknown> = Promise.resolve();
  private readonly connections = new Map<string, Connection>();
  private readonly actionIds: Set<string>;
  private accepting = true;
  private draining = false;
  private readonly drainAbort = new AbortController();
  private readonly turnRunner?: SoloTurnRunner;
  private readonly combatRuntime: CombatRuntime;
  private reactionTimer?: NodeJS.Timeout;
  private turnInFlight = false;
  private turnAbort?: AbortController;
  private turnAccountId?: string;
  private matureDelivery: Promise<void> = Promise.resolve();
  private readonly pendingActions = new Set<string>();
  private chatReceiptSeq: number;
  private chatCommitTail: Promise<void> = Promise.resolve();
  private activeTurn: Promise<void> = Promise.resolve();
  private readonly queuedActions: {
    accountId: string;
    actionId: string;
    originalActionId: string;
    editActionIds: string[];
    text: string;
    playerName: string;
    receiptSeq: number;
    editedAt?: number;
    clarificationAsked?: boolean;
  }[] = [];
  private nextActionReceiptSeq = 0;
  private readonly clarificationTimers = new Map<string, NodeJS.Timeout>();
  private roundTimer?: NodeJS.Timeout;
  private roundReceiptSeq = 0;
  private readonly pendingActionReceipts = new Map<
    number,
    { roundId?: string; actionId?: string; accountId?: string }
  >();
  private readonly completedActionDecisions = new Map<
    number,
    {
      roundId?: string;
      mutation: GatedRoundMutation;
    }
  >();
  private readonly expiredActionReceipts = new Set<number>();
  private readonly actionGateWaiters = new Map<string, () => void>();
  private readonly actionMutationTimes = new Map<string, number[]>();
  private readonly editsPerRound = new Map<string, number>();
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
    this.chatReceiptSeq = Math.max(
      this.seq,
      ...latest.events.map((event) => {
        const payload = event.payload as { receiptSeq?: unknown };
        return typeof payload?.receiptSeq === 'number' ? payload.receiptSeq : 0;
      }),
    );
    this.actionIds = recovered.actionIds;
    this.roundReceiptSeq = Math.max(
      0,
      ...(this.state.round?.submissions.map((item) => item.receiptSeq) ?? []),
      ...(this.state.round?.queuedSubmissions.map((item) => item.receiptSeq) ??
        []),
    );
    this.scheduleRoundTimer();
    queueMicrotask(() => {
      void this.resumeRecoveredRound().catch(() => undefined);
    });
    // A restart mid-prompt resumes the countdown from the persisted deadline.
    this.scheduleReaction();
    for (const [actionId, open] of Object.entries(
      this.state.openClarifications ?? {},
    )) {
      this.pendingActions.add(actionId);
      this.scheduleClarificationTimer(actionId, open.deadlineAt);
    }
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    if (!this.accepting) return Promise.reject(new Error('Room is draining'));
    const result = this.mailbox.then(work);
    this.mailbox = result.catch(() => undefined);
    return result;
  }

  private enqueuePlayer<T>(work: () => Promise<T>): Promise<T> {
    if (this.draining) return Promise.reject(new Error('Room is draining'));
    return this.enqueue(work);
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
    const actionPayload = payload as {
      actionId?: string;
      commandActionId?: string;
      actionIds?: string[];
      submission?: { actionId?: string; actionIds?: string[] };
    };
    const committedActionIds =
      type === 'ActionAccepted' || type === 'ActionEdited'
        ? [
            ...(actionPayload.actionIds ?? []),
            ...(actionPayload.submission?.actionIds ?? []),
            ...((actionPayload.actionId ?? actionPayload.submission?.actionId)
              ? [
                  (actionPayload.actionId ??
                    actionPayload.submission?.actionId) as string,
                ]
              : []),
            ...(actionPayload.commandActionId
              ? [actionPayload.commandActionId]
              : []),
          ]
        : [];
    const actionIds = [...new Set([...this.actionIds, ...committedActionIds])];
    const stored = await this.writeTurn(
      this.sessionId,
      [{ seq: next, turnId: event.turnId, type, payload }],
      { ...state, actionIds },
      this.lease,
    );
    const committed = stored.events[0];
    if (!committed) throw new Error('Persistence returned no event');
    this.seq = committed.seq;
    this.state = state;
    for (const actionId of committedActionIds) this.actionIds.add(actionId);
    return committed;
  }

  /** A failed write reloads the committed head so in-memory seq and state match storage. */
  private async writeTurn(
    ...args: Parameters<RoomStore['writeTurn']>
  ): ReturnType<RoomStore['writeTurn']> {
    return this.withCommittedHeadRecovery(() => this.store.writeTurn(...args));
  }

  private async withCommittedHeadRecovery<T>(
    write: () => Promise<T>,
  ): Promise<T> {
    try {
      return await write();
    } catch (error) {
      await this.reloadCommittedHead().catch(() => undefined);
      throw error;
    }
  }

  private async reloadCommittedHead(): Promise<void> {
    const recovered = recoverRoom(
      this.sessionId,
      await this.store.loadLatest(this.sessionId),
    );
    this.seq = recovered.seq;
    this.state = recovered.state;
    this.actionIds.clear();
    for (const id of recovered.actionIds) this.actionIds.add(id);
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
          payload: { state: this.clientState() },
        });
      this.sendCombatSnapshot(connection);
      for (const [actionId, open] of Object.entries(
        this.state.openClarifications ?? {},
      ))
        if (open.accountId === accountId)
          connection.send({
            seq: this.seq,
            type: 'ClarificationRequested',
            payload: { actionId, question: open.question },
          } as ServerMessage);
    });
  }

  /** Allocates receipt order synchronously at gateway ingress, before async validation or gating. */
  registerChatReceipt(receivedAt: number): ChatReceipt {
    const previous = this.chatCommitTail;
    let finish!: () => void;
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    this.chatCommitTail = done;
    let decision: string | undefined;
    return {
      receiptSeq: ++this.chatReceiptSeq,
      receivedAt,
      previous,
      get decision() {
        return decision;
      },
      decide(reason) {
        if (decision !== undefined) return false;
        decision = reason;
        return true;
      },
      finish,
    };
  }

  async loadChatHistory(accountId: string): Promise<ChatHistoryEntry[]> {
    if (!this.state.seats.some((seat) => seat.accountId === accountId))
      throw new RoomSeatRequiredError();
    if (!this.store.loadChatHistory)
      throw new Error('Chat history unavailable');
    return this.store.loadChatHistory(this.sessionId, 100);
  }

  async commitChat(
    receipt: ChatReceipt,
    message: ChatMessage,
    accountId: string,
  ): Promise<number> {
    await receipt.previous;
    try {
      return await this.enqueue(async () => {
        if (!this.store.writeChat)
          throw new Error('Chat persistence unavailable');
        if (!this.state.seats.some((seat) => seat.accountId === accountId))
          throw new RoomSeatRequiredError();
        let stored: StoredEvent;
        try {
          stored = await this.store.writeChat(
            this.sessionId,
            {
              seq: this.seq + 1,
              turnId: randomUUID(),
              type: 'chat.committed',
              payload: { ...message, accountId },
            },
            this.lease,
          );
        } catch (error) {
          if (!(error instanceof ChatSeatRevokedError)) throw error;
          const rejected = await this.store.writeChat(
            this.sessionId,
            {
              seq: this.seq + 1,
              turnId: randomUUID(),
              type: 'chat.rejected',
              payload: {
                receiptSeq: receipt.receiptSeq,
                receivedAt: receipt.receivedAt,
                reason: 'authorization',
                moderationLogId: message.gateDecision.moderationLogId,
              },
            },
            this.lease,
          );
          this.seq = rejected.seq;
          throw error;
        }
        this.seq = stored.seq;
        this.broadcast({
          seq: this.seq,
          type: 'ChatMessage',
          payload: message,
        });
        return this.seq;
      });
    } finally {
      receipt.finish();
    }
  }

  async rejectChat(
    receipt: ChatReceipt,
    reason: string,
    moderationLogId?: string,
  ): Promise<number> {
    await receipt.previous;
    try {
      return await this.enqueue(async () => {
        if (!this.store.writeChat)
          throw new Error('Chat persistence unavailable');
        const stored = await this.store.writeChat(
          this.sessionId,
          {
            seq: this.seq + 1,
            turnId: randomUUID(),
            type: 'chat.rejected',
            payload: {
              receiptSeq: receipt.receiptSeq,
              receivedAt: receipt.receivedAt,
              reason,
              moderationLogId: moderationLogId ?? null,
            },
          },
          this.lease,
        );
        this.seq = stored.seq;
        return this.seq;
      });
    } finally {
      receipt.finish();
    }
  }

  /** Last-turn narration and player text feed the next DM prompt only; they never go to clients. */
  clientState(): RoomState {
    const seats = this.state.seats.map((seat) => {
      const clientSeat = { ...seat };
      delete clientSeat.matureOptOut;
      return clientSeat;
    });
    const clientVisibleState = { ...this.state };
    delete clientVisibleState.round;
    delete clientVisibleState.closedRoundSubmissions;
    if (!this.state.gameState) return { ...clientVisibleState, seats };
    const gameState = clientGameState(this.state.gameState);
    return { ...clientVisibleState, seats, gameState };
  }

  /** A (re)connecting client gets the tracker and any open reaction prompt with its remaining time. */
  private sendCombatSnapshot(connection: Connection): void {
    const combat = roomGameState(this.state);
    if (!combat) return;
    connection.send(trackerMessage(this.seq, combat));
    if (combat.pendingReaction)
      connection.send(reactionMessage(this.seq, combat.pendingReaction));
  }

  private sendRoundSnapshot(connection: Connection): void {
    const round = this.state.round;
    if (!round) return;
    connection.send({
      seq: this.seq,
      type: 'RoundOpened',
      payload: {
        roundId: round.roundId,
        status: round.status,
        eligibleSeatIds: round.eligibleSeatIds,
        deadlineAt: round.deadlineAt,
        submissions: round.submissions.map(publicRoundSubmission),
        queuedSubmissions: round.queuedSubmissions.map(publicRoundSubmission),
      },
    } as ServerMessage);
  }

  join(
    accountId: string,
    connection: Connection,
    displayName = accountId,
    matureOptOut = false,
    lastSeq = -1,
    options: { requireExistingSeat?: boolean } = {},
  ): Promise<void> {
    return this.enqueue(async () => {
      let seat = this.state.seats.find((item) => item.accountId === accountId);
      if (!seat) {
        if (options.requireExistingSeat) throw new RoomSeatRequiredError();
        if (this.state.seats.length >= 6) throw new Error('Room is full');
        seat = {
          seatId: randomUUID() as RoomState['seats'][number]['seatId'],
          accountId: accountId as RoomState['seats'][number]['accountId'],
          displayName,
          presence: 'offline',
          matureOptOut,
        };
        await this.persist('SeatJoined', seat);
        this.broadcast({
          seq: this.seq,
          type: 'StateSync',
          payload: { state: this.clientState() },
        });
      }
      this.connections.set(accountId, connection);
      if (lastSeq !== this.seq)
        connection.send({
          seq: this.seq,
          type: 'StateSync',
          payload: { state: this.clientState() },
        });
      this.sendCombatSnapshot(connection);
      this.sendRoundSnapshot(connection);
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
      await this.ensureRoundOpen();
    });
  }

  /** Seat an account without a socket; idempotent, atomic against the 6-seat cap via the actor mailbox. */
  seat(
    accountId: string,
    displayName: string,
    matureOptOut = false,
  ): Promise<void> {
    return this.enqueue(async () => {
      if (this.state.seats.some((item) => item.accountId === accountId)) return;
      if (this.state.seats.length >= 6) throw new Error('Room is full');
      await this.persist('SeatJoined', {
        seatId: randomUUID(),
        accountId,
        displayName,
        presence: 'offline',
        matureOptOut,
      });
      this.broadcast({
        seq: this.seq,
        type: 'StateSync',
        payload: { state: this.clientState() },
      });
    });
  }

  isCurrentConnection(accountId: string, connection: Connection): boolean {
    return this.connections.get(accountId) === connection;
  }

  get connectionCount(): number {
    return this.connections.size;
  }

  /** Explicit leave revokes the seat; a dropped socket is only `disconnect`. */
  leave(accountId: string): Promise<void> {
    return this.enqueue(async () => {
      const connection = this.connections.get(accountId);
      this.connections.delete(accountId);
      const seat = this.state.seats.find(
        (item) => item.accountId === accountId,
      );
      if (!seat) {
        connection?.close?.(1000, 'Left the table');
        return;
      }
      if (this.turnInFlight && this.turnAccountId === accountId)
        this.turnAbort?.abort();
      this.withdrawQueuedFor(accountId);
      await this.persist('SeatRevoked', { seatId: seat.seatId, accountId });
      this.state = {
        ...this.state,
        seats: this.state.seats.filter((item) => item.seatId !== seat.seatId),
      };
      this.broadcast({
        seq: this.seq,
        type: 'StateSync',
        payload: { state: this.clientState() },
      });
      connection?.close?.(1000, 'Left the table');
    });
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
      this.assertNotNarrating();
      const nextState = RoomStateSchema.parse({
        ...this.state,
        gameState,
        roundsEnabled: true,
      });
      const stored = await this.writeTurn(
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
      await this.ensureRoundOpen();
    });
  }

  persistRecap(recap: { recap: string; memoryHash: string }): Promise<void> {
    return this.enqueue(async () => {
      const gameState = {
        ...((this.state.gameState as Record<string, unknown>) ?? {}),
        recap,
      };
      const nextState = RoomStateSchema.parse({ ...this.state, gameState });
      const stored = await this.writeTurn(
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
      const current = { ...gameState };
      delete current.checkpoint;
      await this.commitGameState(
        { ...gameState, checkpoint: structuredClone(current) },
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
      this.assertNotNarrating();
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
      this.assertNotNarrating();
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
      this.assertNotNarrating();
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
        const restoredCombat = (restored as { combatRoom?: object }).combatRoom;
        await this.commitGameState(
          {
            ...restored,
            ...(restoredCombat
              ? { combatRoom: { ...restoredCombat, seed: restored.seed } }
              : {}),
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

  private assertNotNarrating(): void {
    if (this.turnInFlight)
      throw new Error('The DM is still narrating; try again in a moment.');
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
    const stored = await this.writeTurn(
      this.sessionId,
      writes,
      parsed,
      this.lease,
    );
    this.seq = stored.events.at(-1)?.seq ?? this.seq;
    this.state = parsed;
  }

  /** Host cap change, serialized with this Room's own writes so its seq stays contiguous. */
  setHostTierCap(cap: HostCap | null): Promise<void> {
    if (!this.accepting) throw new LeaseConflictError('Room is draining');
    return this.enqueue(async () => {
      const [event] = await this.withCommittedHeadRecovery(() =>
        this.store.writeHostTierCap(
          this.sessionId,
          cap,
          this.lease,
          this.seq + 1,
        ),
      );
      if (!event) return;
      this.seq = event.seq;
      this.broadcast({
        seq: this.seq,
        type: 'StateSync',
        payload: { state: this.clientState() },
      });
    });
  }

  /** Any seated player may pause; only the table host (campaign creator) may resume. A pause only blocks narrations that have not started; resuming restarts any queued turns. */
  setPaused(
    accountId: string,
    paused: boolean,
    isHost: boolean,
  ): Promise<void> {
    return this.enqueuePlayer(async () => {
      if (!this.state.seats.some((seat) => seat.accountId === accountId))
        throw new Error('Account is not seated');
      if (!paused && !isHost) throw new NotTableHostError();
      if ((this.state.paused ?? false) === paused) return;
      await this.persist('TablePaused', { paused });
      if (paused) await this.freezeRoundTimer();
      else await this.resumeRoundTimer();
      this.broadcast({
        seq: this.seq,
        type: 'StateSync',
        payload: { state: this.clientState() },
      });
      if (!paused) this.kickQueue();
    });
  }

  /** Host-only. Restores state, map and transcript to just before the last resolved DM turn; once per resolved turn. */
  rewindLastTurn(accountId: string): Promise<void> {
    return this.enqueuePlayer(async () => {
      if (!this.state.seats.some((seat) => seat.accountId === accountId))
        throw new Error('Account is not seated');
      if (!this.store.loadRewindPlan || !this.store.isTableHost)
        throw new Error('Rewind is unavailable');
      if (!(await this.store.isTableHost(this.sessionId, accountId)))
        throw new NotTableHostError('Only the table host can rewind');
      if (this.turnInFlight)
        throw new RewindRefusedError('The DM is still narrating.');
      const plan = await this.store.loadRewindPlan(this.sessionId);
      if (!plan)
        throw new RewindRefusedError('There is no resolved turn to rewind.');
      if (plan.rewindUsed)
        throw new RewindRefusedError(
          'Only one rewind per resolved turn; let the next turn resolve first.',
        );
      const restored = recoverRoom(this.sessionId, plan.before);
      let restoredState = restored.state;
      for (const event of plan.retained)
        restoredState = reduceRoom(restoredState, event);
      const actionIds = new Set(restored.actionIds);
      for (const event of plan.retained)
        if (event.type === 'ActionAccepted')
          actionIds.add((event.payload as { actionId: string }).actionId);
      const reverted = TurnRevertedSchema.parse({
        type: 'TurnReverted',
        turnId: randomUUID(),
        revertedTurnId: plan.turnId,
      });
      const stored = await this.writeTurn(
        this.sessionId,
        [{ turnId: reverted.turnId, type: reverted.type, payload: reverted }],
        { ...restoredState, actionIds: [...actionIds] },
        this.lease,
        [],
        plan.headSeq,
        undefined,
        plan.droppedTurnIds,
      );
      const committed = stored.events.at(-1);
      if (!committed) throw new Error('Persistence returned no event');
      this.seq = committed.seq;
      this.state = restoredState;
      this.actionIds.clear();
      for (const id of actionIds) this.actionIds.add(id);
      this.reconcileClarifications();
      this.scheduleReaction();
      this.broadcast({
        seq: this.seq,
        type: 'TurnReverted',
        payload: { revertedTurnId: plan.turnId },
      });
      this.broadcast({
        seq: this.seq,
        type: 'StateSync',
        payload: { state: this.clientState() },
      });
    });
  }

  /** Host setting: control whether a safety flag aborts the active generation. */
  setXCardAbortEnabled(enabled: boolean): Promise<void> {
    if (!this.accepting) throw new LeaseConflictError('Room is draining');
    if (!this.store.setXCardAbortEnabled)
      throw new Error('X-card abort setting is unavailable');
    return this.enqueue(async () => {
      await this.store.setXCardAbortEnabled!(this.sessionId, enabled);
    });
  }

  /** Anonymous: the seat is stored in the log for abuse handling, but the broadcast carries only the kind. */
  xCard(accountId: string): Promise<void> {
    return this.enqueuePlayer(async () => {
      const seat = this.state.seats.find(
        (item) => item.accountId === accountId,
      );
      if (!seat) throw new Error('Account is not seated');
      await this.persist('SafetyFlag', { seatId: seat.seatId, kind: 'x-card' });
      this.broadcast({
        seq: this.seq,
        type: 'SafetyFlag',
        payload: { kind: 'x-card' },
      } as ServerMessage);
      if (
        this.turnInFlight &&
        (await this.store.xCardAbortEnabled?.(this.sessionId))
      )
        this.turnAbort?.abort();
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

  /** Receipt ordering is allocated synchronously at WebSocket ingress, before moderation. */
  registerActionReceipt(actionId?: string, accountId?: string): number {
    this.roundReceiptSeq += 1;
    this.pendingActionReceipts.set(this.roundReceiptSeq, {
      roundId: this.state.round?.roundId,
      actionId,
      accountId,
    });
    return this.roundReceiptSeq;
  }

  completeActionReceipt(
    receiptSeq: number | undefined,
    mutation?: GatedRoundMutation,
  ): void {
    if (receiptSeq === undefined) return;
    const receipt = this.pendingActionReceipts.get(receiptSeq);
    if (!receipt) return;
    this.pendingActionReceipts.delete(receiptSeq);
    if (mutation)
      this.completedActionDecisions.set(receiptSeq, {
        mutation,
        roundId: receipt.roundId,
      });
    this.wakeActionGateWaiter(receipt.roundId);
  }

  reserveActionMutation(
    accountId: string,
    kind: 'submit' | 'edit' | 'withdraw',
  ): boolean {
    const seat = this.state.seats.find((item) => item.accountId === accountId);
    if (!seat) return false;
    const now = Date.now();
    const recent = (this.actionMutationTimes.get(seat.seatId) ?? []).filter(
      (timestamp) => now - timestamp < 60_000,
    );
    if (recent.length >= 6) return false;
    if (kind === 'edit') {
      const roundId = this.state.round?.roundId ?? 'legacy';
      const key = `${roundId}:${seat.seatId}`;
      const edits = this.editsPerRound.get(key) ?? 0;
      if (edits >= 10) return false;
      this.editsPerRound.set(key, edits + 1);
    }
    recent.push(now);
    this.actionMutationTimes.set(seat.seatId, recent);
    return true;
  }

  private wakeActionGateWaiter(roundId?: string): void {
    if (!roundId) return;
    if (
      [...this.pendingActionReceipts.values()].some(
        (receipt) => receipt.roundId === roundId,
      )
    )
      return;
    const wake = this.actionGateWaiters.get(roundId);
    if (wake) {
      this.actionGateWaiters.delete(roundId);
      wake();
    }
  }

  private async waitForRoundActionGates(roundId: string): Promise<void> {
    if (
      ![...this.pendingActionReceipts.values()].some(
        (receipt) => receipt.roundId === roundId,
      )
    )
      return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        for (const [seq, receipt] of this.pendingActionReceipts)
          if (receipt.roundId === roundId) {
            this.pendingActionReceipts.delete(seq);
            this.expiredActionReceipts.add(seq);
          }
        this.actionGateWaiters.delete(roundId);
        resolve();
      }, ROUND_GATE_GRACE_MS);
      timer.unref?.();
      this.actionGateWaiters.set(roundId, () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  private async flushCompletedActionDecisions(roundId: string): Promise<void> {
    for (const [receiptSeq, decision] of [
      ...this.completedActionDecisions,
    ].sort(([left], [right]) => left - right)) {
      if (decision.roundId !== roundId) continue;
      this.completedActionDecisions.delete(receiptSeq);
      const mutation = decision.mutation;
      if (this.actionIds.has(mutation.actionId)) continue;
      const seat = this.state.seats.find(
        (item) => item.accountId === mutation.accountId,
      );
      if (!seat) continue;
      if (mutation.kind === 'edit') {
        const existing = this.state.round?.submissions.find(
          (item) =>
            item.accountId === mutation.accountId &&
            (item.actionId === mutation.editedActionId ||
              item.originalActionId === mutation.editedActionId ||
              item.actionIds.includes(mutation.editedActionId)),
        );
        if (!existing) continue;
        const submission = {
          ...existing,
          actionId: mutation.actionId,
          actionIds: [...new Set([...existing.actionIds, mutation.actionId])],
          text: mutation.text,
          editedAt: Date.now(),
        };
        await this.persist('RoundActionEdited', { submission, queued: false });
        this.broadcast({
          seq: this.seq,
          type: 'RoundActionEdited',
          payload: {
            roundId,
            seatId: seat.seatId,
            actionId: mutation.actionId,
            receiptSeq: existing.receiptSeq,
          },
        } as ServerMessage);
        continue;
      }
      if (
        this.state.round?.submissions.some(
          (item) => item.seatId === seat.seatId,
        )
      )
        continue;
      const submission = {
        seatId: seat.seatId,
        accountId: seat.accountId,
        actionId: mutation.actionId,
        originalActionId: mutation.actionId,
        actionIds: [mutation.actionId],
        text: mutation.text,
        playerName: mutation.playerName,
        receiptSeq,
      } satisfies NonNullable<RoomState['round']>['submissions'][number];
      this.pendingActions.add(mutation.actionId);
      await this.persist('RoundActionAccepted', { submission, queued: false });
      this.broadcast({
        seq: this.seq,
        type: 'RoundActionAccepted',
        payload: {
          roundId,
          seatId: seat.seatId,
          actionId: mutation.actionId,
          receiptSeq,
        },
      } as ServerMessage);
    }
  }

  private async openRound(): Promise<void> {
    if (!this.state.roundsEnabled || !this.state.gameState || this.state.paused)
      return;
    if (this.state.round?.status === 'open') return;
    const previousQueue = [...(this.state.round?.queuedSubmissions ?? [])].sort(
      (a, b) => a.receiptSeq - b.receiptSeq,
    );
    const round = {
      roundId: randomUUID(),
      status: 'open' as const,
      eligibleSeatIds: this.state.seats
        .filter((seat) => seat.presence !== 'away')
        .map((seat) => seat.seatId),
      deadlineAt:
        this.state.roundDurationMs === null
          ? null
          : Date.now() + (this.state.roundDurationMs ?? DEFAULT_ROUND_MS),
      submissions: previousQueue,
      queuedSubmissions: [],
    } satisfies NonNullable<RoomState['round']>;
    await this.persist('RoundOpened', round);
    this.broadcast({
      seq: this.seq,
      type: 'RoundOpened',
      payload: {
        roundId: round.roundId,
        eligibleSeatIds: round.eligibleSeatIds,
        deadlineAt: round.deadlineAt,
        promoted: previousQueue.map(publicRoundSubmission),
      },
    } as ServerMessage);
    this.scheduleRoundTimer();
  }

  private scheduleRoundTimer(): void {
    if (this.roundTimer) clearTimeout(this.roundTimer);
    this.roundTimer = undefined;
    const round = this.state.round;
    if (!round || round.status !== 'open' || round.deadlineAt === null) return;
    this.roundTimer = setTimeout(
      () => {
        void this.resolveRound('timer').catch(() => undefined);
      },
      Math.max(0, round.deadlineAt - Date.now()),
    );
    this.roundTimer.unref?.();
  }

  private async freezeRoundTimer(): Promise<void> {
    const round = this.state.round;
    if (!round || round.status !== 'open' || round.deadlineAt === null) return;
    if (this.roundTimer) clearTimeout(this.roundTimer);
    this.roundTimer = undefined;
    await this.persist('RoundTimerPaused', {
      roundId: round.roundId,
      remainingMs: Math.max(0, round.deadlineAt - Date.now()),
    });
  }

  private async resumeRoundTimer(): Promise<void> {
    const round = this.state.round;
    if (
      round?.status === 'open' &&
      round.deadlineAt === null &&
      round.remainingMs !== undefined
    ) {
      await this.persist('RoundTimerResumed', {
        roundId: round.roundId,
        deadlineAt: Date.now() + round.remainingMs,
      });
      this.scheduleRoundTimer();
      return;
    }
    if (!round || round.status === 'resolved') await this.openRound();
  }

  private async ensureRoundOpen(): Promise<void> {
    if (!this.state.round) await this.openRound();
  }

  private async resumeRecoveredRound(): Promise<void> {
    const round = this.state.round;
    if (!round || this.state.paused) return;
    if (round.status === 'resolved') {
      await this.enqueue(() => this.openRound());
      return;
    }
    if (round.status === 'closing') {
      // No ingress gates survive a process restart; finish the persisted close.
      void this.resolveRound(round.closeReason ?? 'timer').catch(
        () => undefined,
      );
      return;
    }
    if (round.status === 'resolving' && round.submissions.length > 0) {
      this.turnInFlight = true;
      this.activeTurn = this.executeRoundBatch(
        round.submissions,
        round.roundId,
      );
      void this.activeTurn.catch(() => undefined);
    }
  }

  resolveNow(accountId: string): Promise<void> {
    return this.resolveRound('resolve-now', accountId);
  }

  configureRoundTimer(
    accountId: string,
    durationMs: number | null,
  ): Promise<void> {
    return this.enqueue(async () => {
      if (
        !this.store.isTableHost ||
        !(await this.store.isTableHost(this.sessionId, accountId))
      )
        throw new NotTableHostError('Only the table host can configure rounds');
      await this.persist('RoundTimerConfigured', { durationMs });
      this.broadcast({
        seq: this.seq,
        type: 'RoundTimerConfigured',
        payload: { durationMs },
      } as ServerMessage);
    });
  }

  private resolveRound(
    reason: 'all-submitted' | 'timer' | 'resolve-now',
    requesterAccountId?: string,
  ): Promise<void> {
    const initialRoundId = this.state.round?.roundId;
    const settleGates = initialRoundId
      ? this.waitForRoundActionGates(initialRoundId)
      : Promise.resolve();
    let resolvingRoundId: string | undefined;
    const resolution = settleGates.then(() =>
      this.enqueuePlayer(async () => {
        if (reason === 'resolve-now') {
          if (
            !requesterAccountId ||
            !this.store.isTableHost ||
            !(await this.store.isTableHost(this.sessionId, requesterAccountId))
          )
            throw new NotTableHostError('Only the table host can resolve now');
        }
        if (this.state.paused && reason === 'resolve-now')
          throw new RoomPausedError();
        if (this.state.paused) return;
        const round = this.state.round;
        if (!round || (round.status !== 'open' && round.status !== 'closing'))
          return;
        resolvingRoundId = round.roundId;
        const currentEligible = new Set(
          this.state.seats
            .filter((seat) => seat.presence !== 'away')
            .map((seat) => seat.seatId),
        );
        const required = round.eligibleSeatIds.filter((seatId) =>
          currentEligible.has(seatId),
        );
        const acceptedSeatIds = new Set(
          round.submissions.map((item) => item.seatId),
        );
        if (
          reason === 'all-submitted' &&
          !required.every((seatId) => acceptedSeatIds.has(seatId))
        )
          return;
        if (this.roundTimer) clearTimeout(this.roundTimer);
        this.roundTimer = undefined;
        if (round.status === 'open') {
          await this.persist('RoundClosing', {
            roundId: round.roundId,
            closeReason: reason,
          });
          this.broadcast({
            seq: this.seq,
            type: 'RoundClosing',
            payload: { roundId: round.roundId, closeReason: reason },
          } as ServerMessage);
        }
        await this.flushCompletedActionDecisions(round.roundId);
        for (const [receiptSeq, decision] of this.completedActionDecisions)
          if (decision.roundId === round.roundId)
            this.completedActionDecisions.delete(receiptSeq);
        for (const key of this.editsPerRound.keys())
          if (key.startsWith(`${round.roundId}:`))
            this.editsPerRound.delete(key);
        const batch = [...(this.state.round?.submissions ?? [])].sort(
          (a, b) => a.receiptSeq - b.receiptSeq,
        );
        if (batch.length === 0) {
          await this.persist('RoundClosedEmpty', { roundId: round.roundId });
          this.broadcast({
            seq: this.seq,
            type: 'RoundClosedEmpty',
            payload: { roundId: round.roundId },
          } as ServerMessage);
          await this.openRound();
          return;
        }
        // Re-check eligibility at close; accepted submissions from seats that became away stay in the batch.
        await this.persist('RoundResolved', {
          roundId: round.roundId,
          actions: batch,
        });
        this.broadcast({
          seq: this.seq,
          type: 'RoundResolved',
          payload: {
            roundId: round.roundId,
            actions: batch.map(publicRoundSubmission),
          },
        } as ServerMessage);
        this.turnInFlight = true;
        return batch;
      }).then(async (batch) => {
        if (!Array.isArray(batch)) return;
        await this.executeRoundBatch(
          batch as NonNullable<RoomState['round']>['submissions'],
          resolvingRoundId!,
        );
      }),
    );
    this.activeTurn = resolution;
    void resolution.catch(() => undefined);
    return resolution;
  }

  private async executeRoundBatch(
    actions: NonNullable<RoomState['round']>['submissions'],
    roundId: string,
  ): Promise<void> {
    const first = actions[0];
    if (!first) return;
    const text =
      actions.length === 1
        ? first.text
        : actions
            .map((action) => `${action.playerName}: ${action.text}`)
            .join('\n\n');
    const turnId = actions.length === 1 ? first.actionId : roundId;
    try {
      this.broadcast({
        seq: this.seq,
        type: 'TurnThinking',
        payload: { actionId: turnId },
      } as ServerMessage);
      await this.resolveTurn(
        first.accountId,
        turnId,
        text,
        actions.length === 1 ? first.playerName : 'Party',
        false,
        roundId,
      );
    } catch (error) {
      const restricted = error instanceof LiveDmRestrictedError;
      this.broadcast({
        seq: this.seq,
        type: 'Error',
        payload: {
          code: restricted ? 'LIVE_DM_RESTRICTED' : 'TURN_FAILED',
          message: 'The DM could not complete that round. Try again.',
          actionId: roundId,
        },
      } as ServerMessage);
    } finally {
      await this.enqueue(async () => {
        for (const action of actions)
          for (const id of action.actionIds) this.pendingActions.delete(id);
        this.turnInFlight = false;
        if (
          this.state.round?.roundId === roundId &&
          this.state.round.status === 'resolving'
        )
          await this.persist('RoundCompleted', {
            roundId,
            actionIds: actions.flatMap((action) => action.actionIds),
          });
        await this.openRound();
        const next = this.state.round?.submissions ?? [];
        if (
          next.length > 0 &&
          this.state.round?.eligibleSeatIds.every((seatId) =>
            next.some((item) => item.seatId === seatId),
          )
        )
          queueMicrotask(() => {
            void this.resolveRound('all-submitted').catch(() => undefined);
          });
      });
    }
  }

  hasActionId(
    actionId: string,
    exceptReceiptSeq?: number,
    accountId?: string,
  ): boolean {
    return (
      (accountId === undefined && this.actionIds.has(actionId)) ||
      (accountId === undefined && this.pendingActions.has(actionId)) ||
      [
        ...(this.state.round?.submissions ?? []),
        ...(this.state.round?.queuedSubmissions ?? []),
        ...(this.state.closedRoundSubmissions ?? []),
      ].some(
        (submission) =>
          submission.actionIds.includes(actionId) &&
          (accountId === undefined || submission.accountId === accountId),
      ) ||
      [...this.pendingActionReceipts].some(
        ([seq, receipt]) =>
          seq !== exceptReceiptSeq &&
          receipt.actionId === actionId &&
          (accountId === undefined || receipt.accountId === accountId),
      ) ||
      [...this.completedActionDecisions.values()].some(
        (entry) =>
          entry.mutation.actionId === actionId &&
          (accountId === undefined || entry.mutation.accountId === accountId),
      )
    );
  }

  submitAction(
    accountId: string,
    actionId: string,
    text: string,
    playerName?: string,
    receiptSeq?: number,
  ): Promise<boolean> {
    if (!this.state.roundsEnabled) {
      this.completeActionReceipt(receiptSeq);
      return this.submitLegacyAction(
        accountId,
        actionId,
        text,
        playerName,
        receiptSeq,
      );
    }
    if (receiptSeq !== undefined && this.expiredActionReceipts.has(receiptSeq))
      return Promise.resolve(false);
    if (
      receiptSeq !== undefined &&
      !this.hasActionId(actionId, receiptSeq, accountId)
    )
      this.completeActionReceipt(receiptSeq, {
        kind: 'submit',
        accountId,
        actionId,
        text,
        playerName: playerName ?? accountId,
      });
    let closeAllIn = false;
    return this.enqueuePlayer(async () => {
      const seat = this.state.seats.find(
        (item) => item.accountId === accountId,
      );
      if (!seat) throw new Error('Account is not seated');
      if (!this.turnRunner) throw new Error('Solo turn runner unavailable');
      if (receiptSeq !== undefined)
        this.completedActionDecisions.delete(receiptSeq);
      if (this.hasActionId(actionId, receiptSeq, accountId)) return false;
      await this.ensureRoundOpen();
      const round = this.state.round;
      if (!round) return false;
      const currentSubmissions = round.submissions;
      const queued =
        round.status === 'resolving' ||
        (round.status === 'open' &&
          round.eligibleSeatIds.length === 1 &&
          currentSubmissions.some((item) => item.accountId === accountId));
      if (!queued && round.status !== 'open') return false;
      const submissions = queued ? round.queuedSubmissions : round.submissions;
      if (submissions.some((item) => item.seatId === seat.seatId)) return false;
      if (
        round.queuedSubmissions.filter((item) => item.accountId === accountId)
          .length >= MAX_QUEUED_ACTIONS_PER_SEAT ||
        round.queuedSubmissions.length >= MAX_QUEUED_ACTIONS_PER_ROOM
      )
        throw new Error('ACTION_REJECTED');
      // Direct Room callers have already passed any ingress gate; allocate order
      // without registering a gate receipt that no caller can complete.
      const order = receiptSeq ?? ++this.roundReceiptSeq;
      const submission = {
        seatId: seat.seatId,
        accountId: seat.accountId,
        actionId,
        originalActionId: actionId,
        actionIds: [actionId],
        text,
        playerName: playerName ?? seat.displayName,
        receiptSeq: order,
      } satisfies NonNullable<RoomState['round']>['submissions'][number];
      this.pendingActions.add(actionId);
      await this.persist('RoundActionAccepted', {
        submission,
        queued,
      });
      this.broadcast({
        seq: this.seq,
        type: queued ? 'RoundActionQueued' : 'RoundActionAccepted',
        payload: {
          roundId: round.roundId,
          seatId: seat.seatId,
          actionId,
          receiptSeq: order,
        },
      } as ServerMessage);
      if (!queued) {
        const required = this.state.round!.eligibleSeatIds.filter((seatId) =>
          this.state.seats.some(
            (current) =>
              current.seatId === seatId && current.presence !== 'away',
          ),
        );
        const accepted = new Set(
          this.state.round!.submissions.map((item) => item.seatId),
        );
        closeAllIn = required.every((seatId) => accepted.has(seatId));
      }
      return true;
    }).then(async (accepted) => {
      if (accepted && closeAllIn)
        queueMicrotask(() => {
          void this.resolveRound('all-submitted').catch(() => undefined);
        });
      return accepted;
    });
  }

  private submitLegacyAction(
    accountId: string,
    actionId: string,
    text: string,
    playerName?: string,
    receiptSeq?: number,
  ): Promise<boolean> {
    return this.enqueuePlayer(async () => {
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
      )
        throw new Error('ACTION_REJECTED');
      this.pendingActions.add(actionId);
      this.broadcast({
        seq: this.seq,
        type: 'ActionQueued',
        payload: { actionId },
      } as ServerMessage);
      this.queuedActions.push({
        accountId,
        actionId,
        originalActionId: actionId,
        editActionIds: [],
        text,
        playerName: playerName ?? seat.displayName,
        receiptSeq: receiptSeq ?? this.registerActionReceipt(),
      });
      this.kickQueue();
      return true;
    });
  }

  /** Replace a still-queued submission without changing its batch position. */
  editAction(
    accountId: string,
    actionId: string,
    editedActionId: string,
    text: string,
    receiptSeq?: number,
  ): Promise<'edited' | 'duplicate' | 'unknown_submission' | 'round_closed'> {
    if (receiptSeq !== undefined && this.expiredActionReceipts.has(receiptSeq))
      return Promise.resolve('round_closed');
    if (
      receiptSeq !== undefined &&
      !this.hasActionId(actionId, receiptSeq, accountId)
    )
      this.completeActionReceipt(receiptSeq, {
        kind: 'edit',
        accountId,
        actionId,
        editedActionId,
        text,
      });
    return this.enqueuePlayer(async () => {
      if (receiptSeq !== undefined)
        this.completedActionDecisions.delete(receiptSeq);
      if (this.hasActionId(actionId, receiptSeq, accountId)) return 'duplicate';
      const round = this.state.round;
      if (!round) return 'unknown_submission';
      if (round.status !== 'open' && round.status !== 'resolving')
        return 'round_closed';
      const queued = round.status === 'resolving';
      const list = queued ? round.queuedSubmissions : round.submissions;
      const action = list.find(
        (item) =>
          item.accountId === accountId &&
          (item.actionId === editedActionId ||
            item.originalActionId === editedActionId ||
            item.actionIds.includes(editedActionId)),
      );
      if (!action) {
        const closedSubmission =
          round.submissions.some(
            (item) =>
              item.accountId === accountId &&
              (item.actionId === editedActionId ||
                item.originalActionId === editedActionId ||
                item.actionIds.includes(editedActionId)),
          ) ||
          (this.state.closedRoundSubmissions ?? []).some(
            (item) =>
              item.accountId === accountId &&
              item.actionIds.includes(editedActionId),
          );
        return closedSubmission ? 'round_closed' : 'unknown_submission';
      }
      const editedAt = Date.now();
      const updated = {
        ...action,
        actionId,
        text,
        actionIds: [...new Set([...action.actionIds, actionId])],
        editedAt,
      };
      await this.persist('RoundActionEdited', { submission: updated, queued });
      return 'edited';
    });
  }

  answerClarification(
    accountId: string,
    actionId: string,
    answer: string,
  ): Promise<boolean> {
    return this.enqueuePlayer(async () => {
      const open = this.state.openClarifications?.[actionId];
      if (!open || open.accountId !== accountId) return false;
      await this.closeClarification(actionId, 'answered');
      this.queuedActions.unshift({
        accountId,
        actionId,
        originalActionId: actionId,
        editActionIds: [],
        text: `${open.text}\n[Clarifying question: ${open.question}] Player answers: ${answer}`,
        playerName: open.playerName,
        receiptSeq: ++this.nextActionReceiptSeq,
        clarificationAsked: true,
      });
      this.broadcast({
        seq: this.seq,
        type: 'ActionQueued',
        payload: { actionId },
      } as ServerMessage);
      this.kickQueue();
      return true;
    });
  }

  private closeClarification(
    actionId: string,
    outcome: 'answered' | 'expired',
  ): Promise<StoredEvent> {
    clearTimeout(this.clarificationTimers.get(actionId));
    this.clarificationTimers.delete(actionId);
    return this.persist('ClarificationClosed', { actionId, outcome });
  }

  private reconcileClarifications(): void {
    const open = this.state.openClarifications ?? {};
    for (const actionId of [...this.clarificationTimers.keys()]) {
      if (open[actionId]) continue;
      clearTimeout(this.clarificationTimers.get(actionId));
      this.clarificationTimers.delete(actionId);
      if (!this.queuedActions.some((item) => item.actionId === actionId))
        this.pendingActions.delete(actionId);
    }
    for (const [actionId, clarification] of Object.entries(open)) {
      if (this.clarificationTimers.has(actionId)) continue;
      this.pendingActions.add(actionId);
      this.scheduleClarificationTimer(actionId, clarification.deadlineAt);
    }
  }

  private scheduleClarificationTimer(
    actionId: string,
    deadlineAt: number,
  ): void {
    const timer = setTimeout(
      () => {
        this.clarificationTimers.delete(actionId);
        void this.enqueue(() => this.expireClarification(actionId)).catch(
          () => undefined,
        );
      },
      Math.max(0, deadlineAt - Date.now()),
    );
    timer.unref?.();
    this.clarificationTimers.set(actionId, timer);
  }

  private async expireClarification(actionId: string): Promise<void> {
    if (!this.state.openClarifications?.[actionId]) return;
    this.pendingActions.delete(actionId);
    await this.closeClarification(actionId, 'expired');
    this.broadcast({
      seq: this.seq,
      type: 'ActionWithdrawn',
      payload: { actionId },
    } as ServerMessage);
  }

  private kickQueue(): void {
    if (this.turnInFlight) return;
    this.turnInFlight = true;
    this.activeTurn = this.resolveQueuedTurns();
    void this.activeTurn.catch(() => undefined);
  }

  withdrawAction(accountId: string, actionId: string): Promise<boolean> {
    return this.withdrawRoundAction(accountId, randomUUID(), actionId).then(
      (result) => result === 'withdrawn',
    );
  }

  withdrawRoundAction(
    accountId: string,
    commandActionId: string,
    actionId: string,
  ): Promise<
    | 'withdrawn'
    | 'duplicate'
    | 'unknown_submission'
    | 'round_closed'
    | 'limited'
  > {
    return this.enqueue(async () => {
      if (this.hasActionId(commandActionId, undefined, accountId))
        return 'duplicate';
      if (!this.reserveActionMutation(accountId, 'withdraw')) return 'limited';
      const round = this.state.round;
      if (round) {
        if (round.status === 'closing') return 'round_closed';
        const queued = round.status === 'resolving';
        const list = queued ? round.queuedSubmissions : round.submissions;
        const index = list.findIndex(
          (item) =>
            item.accountId === accountId &&
            (item.actionId === actionId ||
              item.originalActionId === actionId ||
              item.actionIds.includes(actionId)),
        );
        if (index === -1) {
          const existsInBatch =
            round.submissions.some(
              (item) =>
                item.accountId === accountId &&
                item.actionIds.includes(actionId),
            ) ||
            (this.state.closedRoundSubmissions ?? []).some(
              (item) =>
                item.accountId === accountId &&
                item.actionIds.includes(actionId),
            );
          return existsInBatch ? 'round_closed' : 'unknown_submission';
        }
        const submission = list[index]!;
        await this.persist('RoundActionWithdrawn', {
          roundId: round.roundId,
          seatId: submission.seatId,
          accountId,
          commandActionId,
          actionId,
          queued,
        });
        for (const id of submission.actionIds) this.pendingActions.delete(id);
        this.broadcast({
          seq: this.seq,
          type: 'RoundActionWithdrawn',
          payload: { roundId: round.roundId, seatId: submission.seatId },
        } as ServerMessage);
        if (
          !queued &&
          round.eligibleSeatIds.every((seatId) =>
            this.state.round!.submissions.some(
              (item) => item.seatId === seatId,
            ),
          )
        )
          queueMicrotask(() => {
            void this.resolveRound('all-submitted').catch(() => undefined);
          });
        return 'withdrawn';
      }
      const index = this.queuedActions.findIndex(
        (action) =>
          action.accountId === accountId && action.actionId === actionId,
      );
      if (index === -1) return 'unknown_submission';
      this.queuedActions.splice(index, 1);
      this.pendingActions.delete(actionId);
      this.broadcast({
        seq: this.seq,
        type: 'ActionWithdrawn',
        payload: { actionId },
      } as ServerMessage);
      return 'withdrawn';
    });
  }

  private async resolveQueuedTurns(): Promise<void> {
    while (
      !this.draining &&
      !this.state.paused &&
      this.queuedActions.length > 0
    ) {
      const action = this.queuedActions.shift();
      if (!action) continue;
      if (
        !this.state.seats.some((seat) => seat.accountId === action.accountId)
      ) {
        this.pendingActions.delete(action.actionId);
        this.broadcast({
          seq: this.seq,
          type: 'ActionWithdrawn',
          payload: { actionId: action.actionId },
        } as ServerMessage);
        continue;
      }
      this.broadcast({
        seq: this.seq,
        type: 'TurnThinking',
        payload: { actionId: action.actionId },
      } as ServerMessage);
      this.turnAccountId = action.accountId;
      try {
        await this.resolveTurn(
          action.accountId,
          action.actionId,
          action.text,
          action.playerName,
          action.clarificationAsked === true,
        );
      } catch (error) {
        // A turn that throws (e.g. no endpoint configured, table state unavailable) must not
        // leave the player waiting forever. Nothing was committed, so the same action can be
        // resubmitted. The message is deliberately generic: no error text, prompt or secret.
        this.pendingActions.delete(action.actionId);
        if (error instanceof XCardAbortError) {
          this.broadcast({
            seq: this.seq,
            type: 'ActionWithdrawn',
            payload: { actionId: action.actionId },
          } as ServerMessage);
          continue;
        }
        const restricted = error instanceof LiveDmRestrictedError;
        const failure = {
          seq: this.seq,
          type: 'Error',
          payload: restricted
            ? {
                code: 'LIVE_DM_RESTRICTED',
                message:
                  'Live DM turns are limited to approved accounts while moderation is pending.',
                actionId: action.actionId,
              }
            : {
                code: 'TURN_FAILED',
                message:
                  'The DM could not complete that turn. You can try again.',
                actionId: action.actionId,
              },
        } as ServerMessage;
        if (restricted) this.connections.get(action.accountId)?.send(failure);
        else this.broadcast(failure);
      }
    }
    if (this.draining)
      for (const action of this.queuedActions.splice(0)) {
        this.pendingActions.delete(action.actionId);
        this.broadcast({
          seq: this.seq,
          type: 'ActionWithdrawn',
          payload: { actionId: action.actionId },
        } as ServerMessage);
      }
    this.turnAccountId = undefined;
    this.turnInFlight = false;
  }

  private withdrawQueuedFor(accountId: string): void {
    for (let i = this.queuedActions.length - 1; i >= 0; i--) {
      const action = this.queuedActions[i]!;
      if (action.accountId !== accountId) continue;
      this.queuedActions.splice(i, 1);
      this.pendingActions.delete(action.actionId);
      this.broadcast({
        seq: this.seq,
        type: 'ActionWithdrawn',
        payload: { actionId: action.actionId },
      } as ServerMessage);
    }
  }

  private async resolveTurn(
    accountId: string,
    actionId: string,
    text: string,
    playerName: string,
    clarificationAsked: boolean,
    roundId?: string,
  ): Promise<void> {
    const startCombat = JSON.stringify(roomGameState(this.state) ?? null);
    const startGame = structuredClone(this.state.gameState ?? {}) as Record<
      string,
      unknown
    >;
    // Mature narration reaches only the connections present now, so a joiner never receives a turn it was not present for.
    const audience = new Set(this.connections.values());
    let matureAudience: ReadonlySet<Connection> | undefined;
    let liveCompletion: unknown;
    let committedCompletion = false;
    const turnAbort = new AbortController();
    this.turnAbort = turnAbort;
    const xCardAtStart = this.state.xCard ?? { requested: 0, steered: 0 };
    let result;
    try {
      result = await this.turnRunner!.run(
        {
          sessionId: this.sessionId,
          accountId,
          actionId,
          text,
          state: this.state.gameState ?? this.state,
          playerName,
          allowClarification: !clarificationAsked,
          clarificationAsked,
          steerAway: xCardAtStart.requested > xCardAtStart.steered,
          signal: AbortSignal.any([this.drainAbort.signal, turnAbort.signal]),
        },
        (event) => {
          const type = event.type;
          if (type === 'NarrationTier') {
            matureAudience =
              (event as { tier?: unknown }).tier === 'mature'
                ? audience
                : undefined;
          } else if (type === 'RollEvent') {
            this.broadcast({
              seq: this.seq,
              type: 'RollEvent',
              payload: event,
            } as ServerMessage);
          } else if (type === 'NarrationCompleted') {
            // The committed completion below carries the persisted seq; this copy only covers turns that commit none.
            liveCompletion = event;
          } else if (type === 'NarrationChunk') {
            const message = {
              seq: this.seq,
              type,
              payload: event,
            } as ServerMessage;
            if (matureAudience) this.deliverMature(message, matureAudience);
            else this.broadcast(message);
          } else if (type === 'ToolCallRejected') {
            this.broadcast({
              seq: this.seq,
              type: 'ToolRejected',
              payload: { turnId: event.turnId },
            } as ServerMessage);
          }
        },
      );
    } catch (error) {
      this.turnAbort = undefined;
      if (turnAbort.signal.aborted) throw new XCardAbortError();
      throw error;
    }
    this.turnAbort = undefined;
    if (turnAbort.signal.aborted) throw new XCardAbortError();
    await this.matureDelivery;
    // Commit inside the mailbox so a combat command or reaction timeout cannot interleave with it.
    await this.enqueue(async () => {
      if (
        turnAbort.signal.aborted ||
        !this.state.seats.some((seat) => seat.accountId === accountId)
      )
        throw new XCardAbortError();
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
        const clarification = result.clarification;
        if (!clarification) {
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
        }
        if (roundId)
          writes.push({
            seq: undefined,
            turnId: id,
            type: 'RoundCompleted',
            payload: {
              roundId,
              actionIds:
                this.state.round?.roundId === roundId
                  ? this.state.round.submissions.flatMap(
                      (action) => action.actionIds,
                    )
                  : [actionId],
            },
          });
        const nextSeq = this.seq + writes.length;
        const live = this.state.gameState as
          | Record<string, unknown>
          | undefined;
        // A clarification turn made no state changes; its result.state is only the prompt's stub.
        const turnState = (
          clarification
            ? {}
            : result.state && typeof result.state === 'object'
              ? result.state
              : {}
        ) as Record<string, unknown>;
        // Only keys the turn changed overwrite live state, so writes made while narrating survive.
        const turnWrites = Object.fromEntries(
          Object.entries(turnState).filter(
            ([key, value]) =>
              JSON.stringify(value) !== JSON.stringify(startGame[key]),
          ),
        );
        let incoming = { ...live, ...turnWrites } as Record<string, unknown>;
        // Combat that moved on while the DM was narrating is owned by the Room, not by the turn.
        if (live && JSON.stringify(live.combatRoom ?? null) !== startCombat)
          incoming = {
            ...incoming,
            combatRoom: live.combatRoom,
            combatActors: live.combatActors,
          };
        // settleEngine copies combat HP back onto characters, so the turn's HP changes land as deltas on combat HP.
        const startChars = (startGame.characters ?? {}) as Record<
          string,
          { id: string; hp: { current: number } }
        >;
        const turnChars = (turnWrites.characters ?? {}) as Record<
          string,
          { id: string; hp: { current: number } }
        >;
        const hpDelta = new Map<string, number>();
        for (const [accountKey, character] of Object.entries(turnChars)) {
          const before = startChars[accountKey];
          if (before)
            hpDelta.set(character.id, character.hp.current - before.hp.current);
        }
        const combatNow = incoming.combatRoom as RoomCombatState | undefined;
        const hpChanges = combatNow
          ? [...hpDelta].flatMap(([entityId, delta]) => {
              const entity = combatNow.entities.find((e) => e.id === entityId);
              return entity
                ? [
                    {
                      type: 'HpChanged',
                      entityId,
                      from: entity.hp,
                      to: Math.min(
                        entity.maxHp,
                        Math.max(0, entity.hp + delta),
                      ),
                    },
                  ]
                : [];
            })
          : [];
        const hurt =
          combatNow && hpChanges.length
            ? withHp(combatNow, hpChanges)
            : undefined;
        if (hurt) incoming = { ...incoming, combatRoom: hurt.state };
        const reconciled = this.combatRuntime.reconcile(incoming, Date.now());
        const combatEvents = [
          ...(hurt?.events ?? []),
          ...(reconciled?.events ?? []),
        ];
        const turnGameState = reconciled?.gameState ?? incoming;
        for (const event of combatEvents)
          writes.push({
            seq: undefined,
            turnId: id,
            type: String(event.type),
            payload: event,
          });
        const deadlineAt = Date.now() + CLARIFICATION_TIMEOUT_MS;
        const nextState = {
          ...this.state,
          gameState: settleEngine(turnGameState),
          ...(roundId && this.state.round?.roundId === roundId
            ? { round: { ...this.state.round, status: 'resolved' as const } }
            : {}),
          ...(!clarification && {
            xCard: {
              requested: this.state.xCard?.requested ?? 0,
              steered: Math.max(
                this.state.xCard?.steered ?? 0,
                xCardAtStart.requested,
              ),
            },
          }),
          ...(clarification && {
            openClarifications: {
              ...this.state.openClarifications,
              [actionId]: {
                accountId,
                playerName,
                text,
                question: clarification.question,
                deadlineAt,
              },
            },
          }),
        } as RoomState;
        writes.push({
          seq: undefined,
          turnId: id,
          type: 'GameStateCommitted',
          payload: { gameState: nextState.gameState },
        });
        const snapshotState = {
          ...nextState,
          actionIds: clarification
            ? [...this.actionIds]
            : [
                ...this.actionIds,
                ...(roundId && this.state.round?.roundId === roundId
                  ? this.state.round.submissions.flatMap(
                      (action) => action.actionIds,
                    )
                  : [actionId]),
              ],
        };
        const stored = await this.writeTurn(
          this.sessionId,
          writes,
          snapshotState,
          this.lease,
          registryEvents,
          undefined,
          id,
        );
        this.seq = stored.events.at(-1)?.seq ?? nextSeq;
        this.state = nextState;
        if (!clarification && roundId)
          for (const submitted of this.state.round?.roundId === roundId
            ? this.state.round.submissions.flatMap((action) => action.actionIds)
            : [actionId])
            this.actionIds.add(submitted);
        const narrationEvent = stored.events.find(
          (event) => event.type === 'NarrationCompleted',
        );
        if (narrationEvent && !clarification) {
          committedCompletion = true;
          const reportableNarration = {
            seq: narrationEvent.seq,
            type: 'NarrationCompleted',
            payload: { turnId: id, text: result.narration },
          } as ServerMessage;
          if (matureAudience)
            this.deliverMature(reportableNarration, matureAudience);
          else this.broadcast(reportableNarration);
        }
        for (const event of stored.events)
          if (event.type === 'ContentTierChanged')
            this.broadcast({
              seq: event.seq,
              type: 'ContentTierChanged',
              payload: event.payload,
            } as ServerMessage);
        if (clarification) {
          this.scheduleClarificationTimer(actionId, deadlineAt);
          this.broadcast({
            seq: this.seq,
            type: 'ClarificationRequested',
            payload: { actionId, question: clarification.question },
          } as ServerMessage);
        } else this.actionIds.add(actionId);
        const room = roomGameState(nextState);
        if (room && combatEvents.length)
          this.announceCombat(room, combatEvents, accountId);
      }
      if (liveCompletion && !committedCompletion) {
        const message = {
          seq: this.seq,
          type: 'NarrationCompleted',
          payload: liveCompletion,
        } as ServerMessage;
        if (matureAudience) this.deliverMature(message, matureAudience);
        else this.broadcast(message);
      }
      if (!result.clarification) this.pendingActions.delete(actionId);
    });
  }
  submitCombatCommand(
    accountId: string,
    actionId: string,
    command: CombatCommand['payload'],
  ): Promise<boolean> {
    return this.enqueuePlayer(async () => {
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
    const stored = await this.writeTurn(
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
      originalActionId: actionId,
      editActionIds: [],
      text: `[Combat resolved by the engine; narrate it, do not change it] ${facts.join(' ')}`,
      playerName: 'Combat',
      receiptSeq: ++this.nextActionReceiptSeq,
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

  /** Chained so chunks keep their order; each chunk re-checks opt-outs, and any lookup failure sends nothing. */
  private deliverMature(
    message: ServerMessage,
    audience: ReadonlySet<Connection>,
  ): void {
    this.matureDelivery = this.matureDelivery
      .then(async () => {
        const recipients = [...this.connections].filter(
          ([accountId, connection]) =>
            audience.has(connection) &&
            this.state.seats.some((seat) => seat.accountId === accountId),
        );
        if (recipients.length === 0) return;
        let eligible: string[] = [];
        try {
          eligible =
            (await this.store.matureEligibleAccounts?.(
              recipients.map(([accountId]) => accountId),
            )) ?? [];
        } catch {
          eligible = [];
        }
        const allowed = new Set(eligible);
        for (const [accountId, connection] of recipients)
          if (
            allowed.has(accountId) &&
            this.connections.get(accountId) === connection
          )
            connection.send(message);
      })
      .catch(() => undefined);
  }
  async drain(deadlineMs = DRAIN_DEADLINE_MS): Promise<void> {
    this.draining = true;
    clearTimeout(this.reactionTimer);
    for (const timer of this.clarificationTimers.values()) clearTimeout(timer);
    let deadline: NodeJS.Timeout | undefined;
    const timedOut = new Promise<boolean>((resolve) => {
      deadline = setTimeout(() => resolve(true), deadlineMs);
    });
    try {
      const settled = this.settleTurns().then(() => false);
      if (await Promise.race([settled, timedOut])) {
        this.drainAbort.abort();
        console.error(
          `Room ${this.sessionId} drain deadline of ${deadlineMs}ms passed with a turn still in flight`,
        );
      }
    } finally {
      clearTimeout(deadline);
      this.accepting = false;
      for (const connection of this.connections.values())
        connection.close?.(1013, 'Room unavailable; retry');
      this.connections.clear();
    }
  }

  private async settleTurns(): Promise<void> {
    for (;;) {
      await this.mailbox;
      if (!this.turnInFlight) return;
      await this.activeTurn;
    }
  }
}
