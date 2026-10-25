import { randomUUID } from 'node:crypto';
import {
  RoomStateSchema,
  TurnRevertedSchema,
  type ChatHistoryEntry,
  type RoomState,
  type Seat,
  type ServerMessage,
  type ChatMessage,
  type StateSync,
} from '@game/schema';
import type { RegistryEvent } from '../dm/memory.js';
import {
  ChatSeatRevokedError,
  LeaseConflictError,
  RewindRefusedError,
  type EventInput,
  type LatestState,
  type RewindPlan,
  type SeatCharacterTransition,
  type StoredEvent,
} from '../persistence/index.js';
import { SeatCharacterError } from '../persistence/seatCharacters.js';
import type { HostCap } from '../safety/tier.js';
import type { Lease } from './lease.js';
import { recoverRoom } from './recovery.js';
import { reduceRoom } from './reducer.js';
import { seatEntityId, seatIdFromEntityId } from './seatEntity.js';
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
import { attacksFor, settleEngine } from './combatBootstrap.js';
import { withHp } from './combatEngine.js';
import type { ActionId } from '@game/schema';
import { loadCatalog } from '@game/rules-engine/room-tools';
import {
  deriveSheet,
  nextDie,
  type Catalog,
  type CharacterInput,
} from '@game/rules-engine';
import { lateJoinSpawnCell } from './lateJoinSpawn.js';
import { resolveSoloRest } from './rest.js';
import {
  castRestVote as addRestVoteCast,
  cancelRestVoteForCombat,
  evaluateRestVote,
  type RestVote,
} from './restVote.js';
import { failForward, resolveDeathSave, retryFromCheckpoint } from './death.js';

const CLIENT_GAME_STATE_FIELDS = ['characters', 'combatRoom'] as const;

function clientGameState(
  value: unknown,
  viewerAccountId?: string,
  bindings?: ReadonlyMap<string, PrivateSeatCharacterBinding>,
  allowLegacyAccountKey = false,
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const source = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const key of CLIENT_GAME_STATE_FIELDS) {
    if (!(key in source)) continue;
    if (
      key === 'combatRoom' &&
      source.combatRoom &&
      typeof source.combatRoom === 'object' &&
      !Array.isArray(source.combatRoom)
    ) {
      const combatRoom = { ...(source.combatRoom as Record<string, unknown>) };
      delete combatRoom.turnNarrationEvents;
      delete combatRoom.narrationAttempts;
      delete combatRoom.turnNarrationEventIds;
      result[key] = combatRoom;
      continue;
    }
    if (
      key !== 'characters' ||
      !source.characters ||
      typeof source.characters !== 'object'
    ) {
      result[key] = source[key];
      continue;
    }
    const characters: Record<string, unknown> = {};
    for (const [seatId, character] of Object.entries(
      source.characters as Record<string, unknown>,
    )) {
      const isOwner =
        viewerAccountId !== undefined &&
        (bindings?.get(seatId)?.accountId === viewerAccountId ||
          (allowLegacyAccountKey && seatId === viewerAccountId));
      if (isOwner) {
        characters[seatId] = character;
        continue;
      }
      if (
        !character ||
        typeof character !== 'object' ||
        Array.isArray(character)
      ) {
        characters[seatId] = character;
        continue;
      }
      const card = character as Record<string, unknown>;
      characters[seatId] = Object.fromEntries(
        ['id', 'name', 'speciesId', 'classId', 'level', 'hp']
          .filter((field) => field in card)
          .map((field) => [field, card[field]]),
      );
    }
    result[key] = characters;
  }
  if (source.checkpoint && typeof source.checkpoint === 'object')
    result.checkpoint = clientGameState(
      source.checkpoint,
      viewerAccountId,
      bindings,
      allowLegacyAccountKey,
    );
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

export interface PrivateSeatCharacterBinding {
  seatId: string;
  accountId: string | null;
  characterSnapshot: Record<string, unknown>;
}

export interface RoomStore {
  loadLatest(sessionId: string): Promise<LatestState>;
  loadSessionMode?(sessionId: string): Promise<'solo' | 'party'>;
  validateLateJoinCharacter?(
    accountId: string,
    characterId: string,
    expectedRevision: number,
  ): Promise<{ name: string; classId: string; level: number }>;
  loadActiveSeatCharacterBindings?(
    sessionId: string,
  ): Promise<PrivateSeatCharacterBinding[]>;
  createSeatResumeToken?(sessionId: string, seatId: string): Promise<string>;
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
    seatCharacterTransition?: SeatCharacterTransition,
  ): Promise<{ events: StoredEvent[]; binding?: PrivateSeatCharacterBinding }>;
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
  isAccountActive(accountId: string): Promise<boolean>;
  loadRewindPlan?(sessionId: string): Promise<RewindPlan | null>;
  isTableHost?(sessionId: string, accountId: string): Promise<boolean>;
  tableHostAccountId?(sessionId: string): Promise<string | undefined>;
  transferTableHost?(
    sessionId: string,
    currentAccountId: string,
    newAccountId: string,
  ): Promise<void>;
  endTable?(sessionId: string): Promise<void>;
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

interface PendingSeatClaim {
  claimId: string;
  accountId: string;
  seatId: string;
  displayName: string;
  expiresAt: number;
  timer: ReturnType<typeof setTimeout>;
  decide: (approved: boolean) => void;
}

export const CLARIFICATION_TIMEOUT_MS = 10 * 60_000;

/**
 * Advertised turn deadline carried by TurnOpened (ADR-033 §7.1 requires the
 * field). Informational only: nothing enforces expiry yet. The timer and the
 * TurnTimedOut producer are M4-6b, a separate PR.
 */
const TURN_DEADLINE_MS = 90_000;
const DRAIN_DEADLINE_MS = 30_000;
const DEFAULT_ROUND_MS = 120_000;
const ROUND_GATE_GRACE_MS = 5_000;
const PRESENCE_HOLD_MS = 10_000;
const AWAY_AFTER_MS = 30_000;
const SEAT_CLAIM_TTL_MS = 60_000;
const LATE_JOIN_REQUEST_TTL_MS = 10 * 60_000;
const PRESENCE_EVENT_WINDOW_MS = 10_000;

/** Exploration admission waits for a committed scene close or resolved round; combat waits for the next initiative round. */
export function nextLateJoinBoundary(input: {
  turnInFlight: boolean;
  combatActive: boolean;
  roundStatus?: NonNullable<RoomState['round']>['status'];
  sceneBoundary?: boolean;
}): 'after-turn' | 'next-combat-round' | 'before-next-turn' {
  if (input.combatActive) return 'next-combat-round';
  if (
    input.turnInFlight ||
    (input.roundStatus && input.roundStatus !== 'resolved') ||
    (!input.sceneBoundary && input.roundStatus !== 'resolved')
  )
    return 'after-turn';
  return 'before-next-turn';
}

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

export class LateJoinLimitedError extends Error {
  constructor(readonly retryAfterSeconds?: number) {
    super('request_limited');
    this.name = 'LateJoinLimitedError';
  }
}

export class LateJoinRequestConflictError extends Error {
  constructor() {
    super('Late-join request conflicts with an existing request');
    this.name = 'LateJoinRequestConflictError';
  }
}

export class LateJoinUnavailableError extends Error {
  constructor() {
    super('Late-join table unavailable');
    this.name = 'LateJoinUnavailableError';
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
  private readonly pendingSeatResumeTokens = new Map<
    string,
    {
      token: string;
      authTokenHash: string;
      expiresAt: number;
      expiryTimer: NodeJS.Timeout;
    }
  >();
  private readonly lateJoinAuthTokenHashes = new Map<string, string>();
  private readonly lateJoinExpiryTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  private readonly presenceTimers = new Map<string, NodeJS.Timeout>();
  private readonly pendingPresenceEvents = new Map<
    string,
    {
      presence: Seat['presence'];
      type: string;
      payload: Record<string, unknown>;
      notBefore: number;
    }
  >();
  private readonly presenceEventTimers = new Map<string, NodeJS.Timeout>();
  private readonly disconnectedAt = new Map<string, number>();
  private readonly disconnectedMs = new Map<string, number>();
  private readonly actionIds: Set<string>;
  private accepting = true;
  private draining = false;
  private readonly drainAbort = new AbortController();
  private readonly turnRunner?: SoloTurnRunner;
  private readonly combatRuntime: CombatRuntime;
  private combatRoundForLateJoin = 0;
  private reactionTimer?: NodeJS.Timeout;
  private restVoteTimer?: NodeJS.Timeout;
  private turnInFlight = false;
  private turnAbort?: AbortController;
  private turnAccountId?: string;
  private matureDelivery: Promise<void> = Promise.resolve();
  private readonly pendingActions = new Set<string>();
  private readonly seatClaims = new Map<string, PendingSeatClaim>();
  private sceneBoundaryPending = false;
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
    combatTurnId?: string;
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
  /** Server-only rules input, never included in RoomState or any client projection. */
  private readonly seatBindings: Map<string, PrivateSeatCharacterBinding>;
  /**
   * ADR-035: persisted `sessions.mode === 'party'` (never seat count or binding size) makes every
   * gameplay command require a bound seat. Solo sessions and legacy SeatJoined replay are unchanged.
   */
  private readonly bindingEnforced: boolean;
  seq: number;

  get seatCharacters(): ReadonlyMap<string, PrivateSeatCharacterBinding> {
    return this.seatBindings;
  }

  constructor(
    private readonly store: RoomStore,
    readonly lease: Lease,
    latest: LatestState,
    turnRunner?: SoloTurnRunner,
    combatRuntime: CombatRuntime = createCombatRuntime(),
    seatCharacterBindings: readonly PrivateSeatCharacterBinding[] = [],
    partyMode = false,
  ) {
    if (!lease || lease.expiresAt <= new Date())
      throw new Error('Room requires a live lease');
    this.sessionId = lease.sessionId;
    this.seatBindings = new Map(
      seatCharacterBindings.map((binding) => [binding.seatId, binding]),
    );
    this.bindingEnforced = partyMode;
    this.turnRunner = turnRunner;
    this.combatRuntime = combatRuntime;
    const recovered = recoverRoom(this.sessionId, latest);
    this.state = RoomStateSchema.parse({
      ...recovered.state,
      seats: recovered.state.seats.map((seat) => ({
        ...seat,
        // Process recovery cannot prove a pre-crash socket is still alive.
        // Preserve revocation, but make every other persisted status unknown.
        presence: seat.presence === 'revoked' ? 'revoked' : 'unknown',
      })),
    });
    this.combatRoundForLateJoin = roomGameState(this.state)?.combat?.round ?? 0;
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
      void this.enqueue(async () => {
        for (const request of [...(this.state.lateJoinRequests ?? [])])
          if (request.expiresAt === undefined)
            await this.expireLateJoinRequestNow(request.requestId);
      }).catch(() => undefined);
      void this.resumeRecoveredRound().catch(() => undefined);
      void this.cancelScrubbedRecoveredVote().catch((error) =>
        console.error(`Rest vote recovery failed for ${this.sessionId}`, error),
      );
      const combat = roomGameState(this.state);
      if (combat?.phase === 'narrating' && combat.turnId) {
        this.queueNarration(
          combat.turnNarrationEvents ?? [],
          undefined,
          combat.turnId,
        );
      }
    });
    // A restart mid-prompt resumes the countdown from the persisted deadline.
    this.scheduleReaction();
    this.scheduleRestVoteTimer();
    for (const [actionId, open] of Object.entries(
      this.state.openClarifications ?? {},
    )) {
      this.pendingActions.add(actionId);
      this.scheduleClarificationTimer(actionId, open.deadlineAt);
    }
    for (const request of this.state.lateJoinRequests ?? [])
      if (request.expiresAt !== undefined)
        this.scheduleLateJoinExpiry(request.requestId, request.expiresAt);
  }

  private scheduleLateJoinExpiry(requestId: string, expiresAt: number): void {
    const previous = this.lateJoinExpiryTimers.get(requestId);
    if (previous) clearTimeout(previous);
    const timer = setTimeout(
      () => void this.expireLateJoinRequest(requestId).catch(() => undefined),
      Math.max(0, expiresAt - Date.now()),
    );
    timer.unref?.();
    this.lateJoinExpiryTimers.set(requestId, timer);
  }

  private async expireLateJoinRequestNow(requestId: string): Promise<void> {
    const request = this.state.lateJoinRequests?.find(
      (item) => item.requestId === requestId,
    );
    if (!request) return;
    const seat = this.state.seats.find(
      (item) => item.accountId === request.accountId,
    );
    if (seat) {
      const connection = this.connections.get(seat.accountId);
      this.connections.delete(seat.accountId);
      await this.withdrawSeatActions(seat);
      await this.persist('SeatRevoked', {
        seatId: seat.seatId,
        accountId: seat.accountId,
        cause: 'late-join-expired',
      });
      connection?.close?.(1008, 'Late join expired');
    }
    await this.persist('LateJoinExpired', {
      requestId,
      reason: 'timeout',
    });
    const timer = this.lateJoinExpiryTimers.get(requestId);
    if (timer) clearTimeout(timer);
    this.lateJoinExpiryTimers.delete(requestId);
    this.lateJoinAuthTokenHashes.delete(requestId);
    this.broadcast({
      seq: this.seq,
      type: 'StateSync',
      payload: this.clientSyncPayload(),
    });
  }

  private expireLateJoinRequest(requestId: string): Promise<void> {
    return this.enqueue(async () => {
      const request = this.state.lateJoinRequests?.find(
        (item) => item.requestId === requestId,
      );
      if (
        request &&
        (request.expiresAt === undefined || request.expiresAt <= Date.now())
      )
        await this.expireLateJoinRequestNow(requestId);
    });
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

  private async persist(
    type: string,
    payload: unknown,
    seatCharacterTransition?: SeatCharacterTransition,
    additionalActionIds: readonly string[] = [],
  ): Promise<StoredEvent> {
    // ADR-035 §2: revoke/leave/kick releases the binding in the same serialized write.
    let released: { seatId: string; reason: string } | undefined;
    if (!seatCharacterTransition && type === 'SeatRevoked') {
      const revoked = payload as {
        seatId?: unknown;
        accountId?: unknown;
        cause?: unknown;
      };
      if (
        typeof revoked.seatId === 'string' &&
        typeof revoked.accountId === 'string'
      ) {
        seatCharacterTransition = {
          kind: 'release',
          seatId: revoked.seatId,
          accountId: revoked.accountId,
        };
        released = {
          seatId: revoked.seatId,
          reason: typeof revoked.cause === 'string' ? revoked.cause : 'left',
        };
      }
    }
    const next = this.seq + 1;
    const turnId = randomUUID();
    const event: StoredEvent = {
      sessionId: this.sessionId,
      seq: next,
      turnId,
      type,
      payload,
      ts: new Date(),
    };
    const inputs = [{ seq: next, turnId, type, payload }];
    const state = reduceRoom(this.state, event);
    if (released) {
      // Identifier-only: no account, character, revision, hash or sheet data.
      inputs.push({
        seq: next + 1,
        turnId,
        type: 'SeatCharacterReleased',
        payload: released,
      });
    }
    const actionPayload = payload as {
      actionId?: string;
      commandActionId?: string;
      actionIds?: string[];
      submission?: { actionId?: string; actionIds?: string[] };
    };
    const committedActionIds = [
      'ActionAccepted',
      'ActionEdited',
      'SeatRevoked',
      'HostTransferred',
      'LateJoinApproved',
      'LateJoinDenied',
      'LateJoinCancelled',
      'TableEnded',
      'ChatMuteChanged',
      'RoundTimerConfigured',
    ].includes(type)
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
    const actionIds = [
      ...new Set([
        ...this.actionIds,
        ...committedActionIds,
        ...additionalActionIds,
      ]),
    ];
    const stored = await this.writeTurn(
      this.sessionId,
      inputs,
      { ...state, actionIds },
      this.lease,
      [],
      undefined,
      undefined,
      [],
      seatCharacterTransition,
    );
    const committed = stored.events[0];
    if (!committed) throw new Error('Persistence returned no event');
    this.seq = stored.events.at(-1)?.seq ?? committed.seq;
    this.state = state;
    if (seatCharacterTransition?.kind === 'bind' && stored.binding)
      this.seatBindings.set(seatCharacterTransition.seatId, stored.binding);
    if (released) this.seatBindings.delete(released.seatId);
    for (const actionId of [...committedActionIds, ...additionalActionIds])
      this.actionIds.add(actionId);
    return committed;
  }

  /** Applies presence immediately and coalesces durable/public state events per ADR-031 §2.8. */
  private async transitionPresence(
    seatId: Seat['seatId'],
    presence: Seat['presence'],
    eventType = 'PresenceChanged',
    extraPayload: Record<string, unknown> = {},
  ): Promise<void> {
    const seat = this.state.seats.find(
      (candidate) => candidate.seatId === seatId,
    );
    if (!seat) return;
    this.state = RoomStateSchema.parse({
      ...this.state,
      seats: this.state.seats.map((candidate) =>
        candidate.seatId === seatId ? { ...candidate, presence } : candidate,
      ),
    });
    const now = Date.now();
    const priorPending = this.pendingPresenceEvents.get(seatId);
    if (presence === 'returning' && priorPending?.type === 'SeatDisconnected') {
      this.pendingPresenceEvents.delete(seatId);
      const timer = this.presenceEventTimers.get(seatId);
      if (timer) clearTimeout(timer);
      this.presenceEventTimers.delete(seatId);
      this.broadcast({
        seq: this.seq,
        type: 'StateSync',
        payload: { ...this.clientSyncPayload(), state: this.clientState() },
      });
      return;
    }
    const last = this.state.presenceEventAt?.[seatId];
    const commit = async (pending: {
      presence: Seat['presence'];
      type: string;
      payload: Record<string, unknown>;
    }) => {
      if (!this.state.seats.some((candidate) => candidate.seatId === seatId)) {
        this.pendingPresenceEvents.delete(seatId);
        const timer = this.presenceEventTimers.get(seatId);
        if (timer) clearTimeout(timer);
        this.presenceEventTimers.delete(seatId);
        return;
      }
      const event = await this.persist(pending.type, pending.payload);
      this.pendingPresenceEvents.delete(seatId);
      const timer = this.presenceEventTimers.get(seatId);
      if (timer) clearTimeout(timer);
      this.presenceEventTimers.delete(seatId);
      this.broadcast({
        seq: event.seq,
        type: 'PresenceChanged',
        payload: { seatId, presence: pending.presence },
      });
    };
    const notBefore = Math.max(
      this.pendingPresenceEvents.get(seatId)?.notBefore ?? 0,
      last === undefined ? 0 : last + PRESENCE_EVENT_WINDOW_MS,
      eventType === 'SeatDisconnected' ? now + PRESENCE_EVENT_WINDOW_MS : 0,
    );
    const pending = {
      presence,
      type: eventType,
      payload: { seatId, presence, ...extraPayload },
      notBefore,
    };
    if (notBefore <= now) {
      await commit(pending);
      return;
    }
    this.pendingPresenceEvents.set(seatId, pending);
    this.broadcast({
      seq: this.seq,
      type: 'StateSync',
      payload: { ...this.clientSyncPayload(), state: this.clientState() },
    });
    const oldTimer = this.presenceEventTimers.get(seatId);
    if (oldTimer) clearTimeout(oldTimer);
    const timer = setTimeout(
      () => {
        void this.enqueue(async () => {
          const currentPending = this.pendingPresenceEvents.get(seatId);
          if (currentPending) await commit(currentPending);
        }).catch(() => undefined);
      },
      Math.max(0, notBefore - now),
    );
    timer.unref?.();
    this.presenceEventTimers.set(seatId, timer);
  }

  bindSeatCharacter(
    accountId: string,
    characterId: string,
    expectedRevision: number,
    validateTicket: () => Promise<boolean>,
    actionId: string,
  ): Promise<void> {
    return this.enqueuePlayer(async () => {
      const seat = this.state.seats.find(
        (item) => item.accountId === accountId,
      );
      if (
        !seat ||
        seat.presence === 'revoked' ||
        this.isPendingLateJoinSeat(seat) ||
        !(await validateTicket())
      )
        throw new RoomSeatRequiredError();
      await this.persist(
        'SeatCharacterBound',
        { seatId: seat.seatId },
        {
          kind: 'bind',
          seatId: seat.seatId,
          accountId,
          characterId,
          expectedRevision,
        },
        [actionId],
      );
      this.actionIds.add(actionId);
      if (this.hasCurrentBinding(seat)) {
        this.broadcast({
          seq: this.seq,
          type: 'SeatCharacterBound',
          payload: { seatId: seat.seatId },
        } as ServerMessage);
        this.connections.get(accountId)?.send({
          seq: this.seq,
          type: 'SeatCharacterBoundPrivate',
          payload: { seatId: seat.seatId },
        } as ServerMessage);
      }
    });
  }

  recordSeatTakenOver(seatId: string): Promise<void> {
    return this.enqueue(async () => {
      const event = await this.persist('SeatTakenOver', {
        seatId,
        at: Date.now(),
      });
      this.broadcast({
        seq: event.seq,
        type: 'SeatTakenOver',
        payload: { seatId, at: event.ts.getTime() },
      } as ServerMessage);
    });
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
      const seat = this.state.seats.find(
        (item) => item.accountId === accountId,
      );
      if (!seat) {
        connection.close?.(1008, 'Seat required to subscribe');
        return;
      }
      const ownerAccountId = await this.store.tableHostAccountId?.(
        this.sessionId,
      );
      const ownerSeat = this.state.seats.find(
        (item) => item.accountId === ownerAccountId,
      );
      if (
        ownerSeat &&
        this.state.seats.some(
          (item) => item.isHost !== (item.seatId === ownerSeat.seatId),
        )
      )
        await this.persist('HostSeatChanged', { seatId: ownerSeat.seatId });
      this.connections.set(accountId, connection);
      if (seat.presence !== 'connected') {
        await this.transitionPresence(seat.seatId, 'connected');
        await this.reconcileConnectionPause();
      }
      if (lastSeq !== this.seq)
        connection.send({
          seq: this.seq,
          type: 'StateSync',
          payload: {
            ...this.clientSyncPayload(),
            state: this.clientState(accountId),
          },
        });
      this.sendCombatSnapshot(connection);
      this.sendSeatPrivateRoundSync(accountId);
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
    if (
      !this.state.seats.some(
        (seat) => seat.accountId === accountId && seat.presence !== 'revoked',
      )
    )
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
        if (
          !this.state.seats.some(
            (seat) =>
              seat.accountId === accountId && seat.presence !== 'revoked',
          )
        )
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
  clientState(
    viewerAccountId?: string,
  ): import('@game/schema').ClientRoomState {
    const seats = this.state.seats.map((seat) => {
      const clientSeat = { ...seat };
      if (
        clientSeat.chatMutedUntil != null &&
        clientSeat.chatMutedUntil <= Date.now()
      ) {
        clientSeat.chatMuted = false;
        clientSeat.chatMutedUntil = undefined;
      }
      delete clientSeat.matureOptOut;
      return clientSeat;
    });
    const revokedSeats = (this.state.revokedSeats ?? []).map((seat) => {
      const clientSeat = { ...seat };
      delete clientSeat.matureOptOut;
      return clientSeat;
    });
    const {
      lateJoinRequests,
      lateJoinRequestResults,
      lateJoinRequestCharacterIds,
      lateJoinActionOwners,
      ...visibleRoomState
    } = this.state;
    void lateJoinRequestResults;
    void lateJoinRequestCharacterIds;
    void lateJoinActionOwners;
    const clientVisibleState: import('@game/schema').ClientRoomState = {
      ...visibleRoomState,
      revokedSeats,
    };
    const isHostViewer = this.state.seats.some(
      (seat) => seat.accountId === viewerAccountId && seat.isHost,
    );
    if (!isHostViewer) {
      delete clientVisibleState.lateJoinRequests;
    } else if (lateJoinRequests) {
      clientVisibleState.lateJoinRequests = lateJoinRequests.flatMap(
        (request) => {
          if (request.approved) return [];
          const character = request.character;
          if (!character || request.expiresAt === undefined) return [];
          return [
            {
              requestId: request.requestId,
              displayName: character.name,
              classId: character.classId,
              level: character.level,
              expiresAt: request.expiresAt,
            },
          ];
        },
      );
    }
    delete clientVisibleState.round;
    delete clientVisibleState.closedRoundSubmissions;
    if (clientVisibleState.restVote) {
      const vote = clientVisibleState.restVote;
      clientVisibleState.restVote = {
        voteId: vote.voteId,
        type: vote.type,
        deadlineAt: vote.deadlineAt,
        ...(vote.remainingMs !== undefined
          ? { remainingMs: vote.remainingMs }
          : {}),
        openedByTurnId: vote.openedByTurnId,
        castSeatIds:
          vote.castSeatIds ?? vote.ballots?.map((ballot) => ballot.seat) ?? [],
      };
    }
    if (!this.state.gameState) return { ...clientVisibleState, seats };
    const gameState = clientGameState(
      this.state.gameState,
      viewerAccountId,
      this.seatBindings,
      !this.bindingEnforced,
    );
    return { ...clientVisibleState, seats, gameState };
  }

  private clientSyncPayload(): StateSync['payload'] {
    const round = this.state.round;
    const boundSeatIds = this.state.seats
      .filter(
        (seat) => seat.presence !== 'revoked' && this.isPlayableSeat(seat),
      )
      .map((seat) => seat.seatId);
    return {
      state: this.clientState(),
      ...(boundSeatIds.length > 0 ? { boundSeatIds } : {}),
      ...(round
        ? {
            round: {
              roundId: round.roundId,
              status: round.status,
              eligibleSeatIds: round.eligibleSeatIds,
              deadlineAt: round.deadlineAt,
              ...(round.deadlineAt !== null
                ? { remainingMs: Math.max(0, round.deadlineAt - Date.now()) }
                : {}),
              ...(round.closeReason ? { closeReason: round.closeReason } : {}),
              submissions: round.submissions.map(publicRoundSubmission),
              queuedSubmissions: round.queuedSubmissions.map(
                publicRoundSubmission,
              ),
            },
          }
        : {}),
    };
  }

  /** A (re)connecting client gets the tracker and any open reaction prompt with its remaining time. */
  private sendCombatSnapshot(connection: Connection): void {
    const combat = roomGameState(this.state);
    if (!combat) return;
    connection.send(trackerMessage(this.seq, combat));
    if (combat.pendingReaction)
      connection.send(reactionMessage(this.seq, combat.pendingReaction));
  }

  private sendSeatPrivateRoundSync(accountId: string): void {
    const connection = this.connections.get(accountId);
    const round = this.state.round;
    if (
      !connection ||
      !round ||
      !this.state.seats.some(
        (seat) => seat.accountId === accountId && seat.presence !== 'revoked',
      )
    )
      return;
    const submission =
      round.submissions.find((item) => item.accountId === accountId) ??
      round.queuedSubmissions.find((item) => item.accountId === accountId);
    connection.send({
      seq: this.seq,
      type: 'SeatPrivateRoundSync',
      payload: {
        roundId: round.roundId,
        ...(submission
          ? {
              submission: {
                actionId: submission.actionId,
                text: submission.text,
                queued: round.queuedSubmissions.includes(submission),
              },
            }
          : {}),
      },
    } as ServerMessage);
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
    authTokenHash?: string,
  ): Promise<void> {
    return this.enqueue(async () => {
      let seat = this.state.seats.find((item) => item.accountId === accountId);
      const pendingReaction = roomGameState(this.state)?.pendingReaction;
      if (
        pendingReaction &&
        this.reactionSeatPresence(pendingReaction.entityId) &&
        ['away', 'revoked', 'unknown'].includes(
          this.reactionSeatPresence(pendingReaction.entityId)!,
        )
      )
        await this.declineExpiredReaction();
      if (!seat) {
        if (options.requireExistingSeat) throw new RoomSeatRequiredError();
        if (
          this.state.seats.filter((item) => item.presence !== 'revoked')
            .length >= 6
        )
          throw new Error('Room is full');
        seat = {
          seatId: randomUUID() as RoomState['seats'][number]['seatId'],
          accountId: accountId as RoomState['seats'][number]['accountId'],
          displayName,
          presence: 'returning',
          isHost: this.store.isTableHost
            ? await this.store.isTableHost(this.sessionId, accountId)
            : false,
          chatMuted: false,
          chatMutedUntil: null,
          matureOptOut,
        };
        await this.persist('SeatJoined', seat);
        const resumeToken = await this.store.createSeatResumeToken?.(
          this.sessionId,
          seat.seatId,
        );
        if (resumeToken && authTokenHash)
          this.setPendingSeatResumeToken(accountId, resumeToken, authTokenHash);
        this.broadcast({
          seq: this.seq,
          type: 'StateSync',
          payload: this.clientSyncPayload(),
        });
      }
      if (seat.presence === 'disconnected') {
        const started = this.disconnectedAt.get(seat.seatId);
        if (started !== undefined) {
          this.disconnectedMs.set(
            seat.seatId,
            (this.disconnectedMs.get(seat.seatId) ?? 0) + Date.now() - started,
          );
          this.disconnectedAt.delete(seat.seatId);
        }
      }
      this.connections.set(accountId, connection);
      this.sendCombatSnapshot(connection);
      this.sendRoundSnapshot(connection);
      this.sendSeatPrivateRoundSync(accountId);
      const initialConnection = seat.presence === 'offline';
      const connectedPresence = initialConnection ? 'connected' : 'returning';
      if (seat.presence !== connectedPresence) {
        const wasAway = seat.presence === 'away';
        const hadVisibleDisconnect = ['SeatDisconnected', 'SeatAway'].includes(
          this.state.presenceEventType?.[seat.seatId] ?? '',
        );
        await this.transitionPresence(
          seat.seatId,
          connectedPresence,
          hadVisibleDisconnect ? 'SeatReconnected' : 'PresenceChanged',
          hadVisibleDisconnect ? { at: Date.now(), wasAway } : {},
        );
      }
      if (!initialConnection && connectedPresence === 'returning')
        this.schedulePresenceTransition(
          seat.seatId,
          'connected',
          PRESENCE_HOLD_MS,
        );
      await this.reconcileConnectionPause();
      await this.ensureRoundOpen();
      if (lastSeq !== this.seq || options.requireExistingSeat)
        connection.send({
          seq: this.seq,
          type: 'StateSync',
          payload: {
            ...this.clientSyncPayload(),
            state: this.clientState(accountId),
          },
        });
      this.sendCombatSnapshot(connection);
      this.sendRoundSnapshot(connection);
      this.sendSeatPrivateRoundSync(accountId);
    });
  }

  /** Seat an account without a socket; idempotent, atomic against the 6-seat cap via the actor mailbox. */
  seat(
    accountId: string,
    displayName: string,
    matureOptOut = false,
    authTokenHash?: string,
  ): Promise<string | undefined> {
    return this.enqueue(async () => {
      const existing = this.state.seats.find(
        (item) => item.accountId === accountId,
      );
      if (existing) return undefined;
      if (
        this.state.seats.filter((item) => item.presence !== 'revoked').length >=
        6
      )
        throw new Error('Room is full');
      const seatId = randomUUID();
      await this.persist('SeatJoined', {
        seatId,
        accountId,
        displayName,
        presence: 'offline',
        isHost: this.store.isTableHost
          ? await this.store.isTableHost(this.sessionId, accountId)
          : false,
        chatMuted: false,
        matureOptOut,
      });
      const resumeToken = await this.store.createSeatResumeToken?.(
        this.sessionId,
        seatId,
      );
      if (resumeToken && authTokenHash)
        this.setPendingSeatResumeToken(accountId, resumeToken, authTokenHash);
      this.broadcast({
        seq: this.seq,
        type: 'StateSync',
        payload: this.clientSyncPayload(),
      });
      return resumeToken;
    });
  }

  private setPendingSeatResumeToken(
    accountId: string,
    token: string,
    authTokenHash: string,
  ): void {
    const previous = this.pendingSeatResumeTokens.get(accountId);
    if (previous) clearTimeout(previous.expiryTimer);
    const pending = {
      token,
      authTokenHash,
      expiresAt: Date.now() + 30_000,
      expiryTimer: setTimeout(() => {
        if (this.pendingSeatResumeTokens.get(accountId) === pending)
          this.pendingSeatResumeTokens.delete(accountId);
      }, 30_000),
    };
    pending.expiryTimer.unref?.();
    this.pendingSeatResumeTokens.set(accountId, pending);
  }

  /** One-time handoff to the exact authenticated session that seated the account. */
  claimPendingSeatResumeToken(
    accountId: string,
    authTokenHash: string,
    now = Date.now(),
  ): string | undefined {
    const pending = this.pendingSeatResumeTokens.get(accountId);
    if (!pending) return undefined;
    if (pending.expiresAt <= now) {
      clearTimeout(pending.expiryTimer);
      this.pendingSeatResumeTokens.delete(accountId);
      return undefined;
    }
    if (pending.authTokenHash !== authTokenHash) return undefined;
    clearTimeout(pending.expiryTimer);
    this.pendingSeatResumeTokens.delete(accountId);
    return pending.token;
  }

  completeSeatResumeTokenDelivery(
    accountId: string,
    authTokenHash: string,
  ): void {
    const pending = this.pendingSeatResumeTokens.get(accountId);
    if (pending?.authTokenHash === authTokenHash) {
      clearTimeout(pending.expiryTimer);
      this.pendingSeatResumeTokens.delete(accountId);
    }
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
      await this.withdrawSeatActions(seat);
      await this.persist('SeatRevoked', { seatId: seat.seatId, accountId });
      this.afterSeatReleased();
      this.broadcast({
        seq: this.seq,
        type: 'StateSync',
        payload: this.clientSyncPayload(),
      });
      const vote = this.asRestVote();
      if (vote) {
        const isHost = this.store.isTableHost
          ? await this.store.isTableHost(this.sessionId, accountId)
          : false;
        const close = evaluateRestVote(vote, Date.now(), isHost);
        if (close)
          await this.finishRestVote(vote, isHost ? 'host-revoked' : 'quorum');
      }
      connection?.close?.(1000, 'Left the table');
    });
  }
  disconnect(accountId: string, disconnectedAt = Date.now()): Promise<void> {
    return this.enqueue(async () => {
      this.connections.delete(accountId);
      const seat = this.state.seats.find(
        (item) => item.accountId === accountId,
      );
      if (seat && seat.presence !== 'disconnected') {
        this.clearPresenceTimer(seat.seatId);
        this.disconnectedAt.set(seat.seatId, disconnectedAt);
        await this.transitionPresence(
          seat.seatId,
          'disconnected',
          'SeatDisconnected',
          {
            at: disconnectedAt,
          },
        );
        this.schedulePresenceTransition(
          seat.seatId,
          'away',
          Math.max(
            0,
            AWAY_AFTER_MS -
              (this.disconnectedMs.get(seat.seatId) ?? 0) -
              Math.max(0, Date.now() - disconnectedAt),
          ),
        );
      }
      await this.reconcileConnectionPause();
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
      this.requireBoundSeat(accountId);
      if (this.state.seats.length > 1 || this.bindingEnforced)
        throw new Error(
          'rest-not-allowed: multiplayer rest requires a party vote',
        );
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

  castRestVote(
    accountId: string,
    voteId: string,
    choice: 'yes' | 'no',
    kind: 'ballot' | 'tiebreak',
    actionId: string,
  ): Promise<void> {
    return this.enqueuePlayer(async () => {
      const vote = this.asRestVote();
      const seat = this.state.seats.find(
        (item) => item.accountId === accountId,
      );
      if (!seat || !vote || vote.voteId !== voteId) {
        this.sendError(
          accountId,
          'vote-closed',
          'That rest vote is closed.',
          actionId,
        );
        return;
      }
      if (
        this.state.paused ||
        !this.connections.has(accountId) ||
        !['connected', 'returning', 'online'].includes(seat.presence) ||
        (this.bindingEnforced && !this.isPlayableSeat(seat))
      ) {
        this.sendError(
          accountId,
          'ballot-not-allowed',
          'Your seat cannot cast a ballot right now.',
          actionId,
        );
        return;
      }
      if (
        kind === 'tiebreak' &&
        (!this.store.isTableHost ||
          !(await this.store.isTableHost(this.sessionId, accountId)))
      ) {
        this.sendError(
          accountId,
          'ballot-not-allowed',
          'Only the host may break a tie.',
          actionId,
        );
        return;
      }
      if (Date.now() >= vote.deadlineAt) {
        await this.finishRestVote(vote, 'timer');
        this.sendError(
          accountId,
          'vote-closed',
          'That rest vote is closed.',
          actionId,
        );
        return;
      }
      const next = addRestVoteCast(vote, seat.seatId, choice, kind);
      if (!next) {
        // A retry of the same (voteId, seat, kind) is idempotent; a different
        // second ballot or invalid tie-break is not.
        if (
          (kind === 'ballot' &&
            vote.ballots.some((ballot) => ballot.seat === seat.seatId)) ||
          (kind === 'tiebreak' && vote.tieBreak)
        )
          return;
        this.sendError(
          accountId,
          'ballot-not-allowed',
          'That ballot is not allowed.',
          actionId,
        );
        return;
      }
      if (!this.reserveActionMutation(accountId, 'rest-vote')) {
        this.sendError(
          accountId,
          'ACTION_LIMITED',
          'Too many recent actions; try again shortly.',
          actionId,
        );
        return;
      }
      await this.persist('RestVoteCast', {
        voteId,
        seat: seat.seatId,
        choice,
      });
      const notice = await this.persist('RestVoteCastNotice', {
        voteId,
        seat: seat.seatId,
      });
      this.broadcast({
        seq: notice.seq,
        type: 'RestVoteCastNotice',
        payload: { voteId, seat: seat.seatId },
      } as ServerMessage);
      const close = evaluateRestVote(next, Date.now());
      if (close) await this.finishRestVote(next, 'quorum');
    });
  }

  private asRestVote(): RestVote | undefined {
    const vote = this.state.restVote;
    if (!vote?.eligibleSeats || vote.deadlineAt === null) return undefined;
    return {
      voteId: vote.voteId,
      type: vote.type,
      eligibleSeats: vote.eligibleSeats,
      ballots: vote.ballots ?? [],
      ...(vote.tieBreak ? { tieBreak: vote.tieBreak } : {}),
      openedByTurnId: vote.openedByTurnId,
      deadlineAt: vote.deadlineAt,
    };
  }

  private async cancelScrubbedRecoveredVote(): Promise<void> {
    if (!this.state.restVote || this.state.restVote.eligibleSeats) return;
    await this.enqueue(async () => {
      const vote = this.state.restVote;
      if (!vote || vote.eligibleSeats) return;
      const turnId = randomUUID();
      const nextState = RoomStateSchema.parse({
        ...this.state,
        restVote: undefined,
        restVoteLastClosedAt: Date.now(),
        lastRestVoteResult: {
          voteId: vote.voteId,
          type: vote.type,
          outcome: 'failed',
          closeReason: 'cancelled',
        },
        lastRestVoteResultTurnId: turnId,
      });
      const stored = await this.writeTurn(
        this.sessionId,
        [
          {
            turnId,
            type: 'RestVoteClosed',
            payload: {
              voteId: vote.voteId,
              outcome: 'failed',
              closeReason: 'cancelled',
              yes: null,
              no: null,
            },
          },
        ],
        nextState,
        this.lease,
      );
      this.seq = stored.events.at(-1)?.seq ?? this.seq;
      this.state = nextState;
      this.broadcast({
        seq: this.seq,
        type: 'RestVoteClosed',
        payload: stored.events[0]?.payload as Record<string, unknown>,
      } as ServerMessage);
    });
  }

  private buildRestVoteOpenEvent(
    turnId: string,
    type: 'short' | 'long',
    completedRoundId?: string,
  ): EventInput | undefined {
    const now = Date.now();
    const round = this.state.round;
    const game = this.state.gameState as
      | {
          combatRoom?: unknown;
          gameEngine?: { combat?: { combatants?: unknown[] } };
        }
      | undefined;
    const inCombat =
      !!game?.combatRoom || !!game?.gameEngine?.combat?.combatants?.length;
    const completesCurrentRound =
      !!completedRoundId &&
      round?.roundId === completedRoundId &&
      round.status === 'resolving';
    if (
      this.state.paused ||
      this.state.seats.length < 2 ||
      this.state.restVote ||
      inCombat ||
      (round &&
        ['open', 'closing', 'resolving'].includes(round.status) &&
        !completesCurrentRound)
    )
      return undefined;
    if ((this.state.restVoteCount ?? 0) >= 6) return undefined;
    if (
      this.state.restVoteLastClosedAt !== undefined &&
      now - this.state.restVoteLastClosedAt < 10 * 60_000
    )
      return undefined;
    return {
      turnId,
      type: 'RestVoteOpened',
      payload: {
        voteId: randomUUID(),
        type,
        eligibleSeats: this.state.seats
          .filter((seat) => !this.bindingEnforced || this.isPlayableSeat(seat))
          .map((seat) => seat.seatId),
        deadlineAt: now + 120_000,
        openedByTurnId: turnId,
      },
    };
  }

  private scheduleRestVoteTimer(): void {
    clearTimeout(this.restVoteTimer);
    const vote = this.asRestVote();
    if (!vote || this.state.paused) return;
    this.restVoteTimer = setTimeout(
      () => {
        void this.enqueue(async () => {
          const current = this.asRestVote();
          if (
            current?.voteId === vote.voteId &&
            Date.now() >= current.deadlineAt
          )
            await this.finishRestVote(current, 'timer');
        }).catch((error) =>
          console.error(`Rest vote timer failed for ${this.sessionId}`, error),
        );
      },
      vote.tieBreak ? 0 : Math.max(0, vote.deadlineAt - Date.now()),
    );
  }

  private async finishRestVote(
    vote: RestVote,
    trigger: 'timer' | 'quorum' | 'combat' | 'host-revoked',
  ): Promise<void> {
    if (this.state.restVote?.voteId !== vote.voteId) return;
    clearTimeout(this.restVoteTimer);
    let close =
      trigger === 'combat'
        ? cancelRestVoteForCombat()
        : evaluateRestVote(
            vote,
            trigger === 'timer' ? vote.deadlineAt : Date.now(),
            trigger === 'host-revoked',
          );
    if (!close && trigger !== 'timer')
      close = evaluateRestVote(
        vote,
        vote.deadlineAt,
        trigger === 'host-revoked',
      );
    if (!close) return;
    const turnId = randomUUID();
    const writes: EventInput[] = [
      {
        turnId,
        type: 'RestVoteClosed',
        payload: {
          voteId: vote.voteId,
          outcome: close.outcome,
          closeReason: close.closeReason,
          yes: close.yes,
          no: close.no,
        },
      },
    ];
    let gameState = this.state.gameState as Record<string, unknown> | undefined;
    if (close.outcome === 'passed' && trigger !== 'combat') {
      if (!gameState)
        throw new Error('Game state is unavailable for rest effects');
      const effects: Record<string, unknown>[] = [];
      for (const seat of this.state.seats) {
        if (
          !(gameState.characters as Record<string, unknown> | undefined)?.[
            seat.accountId
          ]
        )
          continue;
        const rested = resolveSoloRest(
          gameState,
          seat.accountId,
          vote.type,
          loadCatalog(),
        );
        gameState = rested.gameState;
        effects.push(...rested.events);
      }
      writes.push(
        ...effects.map((event) => ({
          turnId,
          type: String(event.type),
          payload: event,
        })),
      );
      writes.push({
        turnId,
        type: 'RestApplied',
        payload: { voteId: vote.voteId, type: vote.type, effects },
      });
      writes.push({
        turnId,
        type: 'GameStateCommitted',
        payload: { gameState },
      });
    }
    const nextState = RoomStateSchema.parse({
      ...this.state,
      restVote: undefined,
      restVoteLastClosedAt: Date.now(),
      lastRestVoteResult: {
        voteId: vote.voteId,
        type: vote.type,
        outcome: close.outcome,
        closeReason: close.closeReason,
      },
      lastRestVoteResultTurnId: turnId,
      gameState,
    });
    const stored = await this.writeTurn(
      this.sessionId,
      writes,
      nextState,
      this.lease,
    );
    this.seq = stored.events.at(-1)?.seq ?? this.seq;
    this.state = nextState;
    const closeEvent = stored.events.find(
      (event) => event.type === 'RestVoteClosed',
    );
    if (closeEvent)
      this.broadcast({
        seq: closeEvent.seq,
        type: 'RestVoteClosed',
        payload: closeEvent.payload as Record<string, unknown>,
      } as ServerMessage);
    if (close.outcome === 'passed' && trigger !== 'combat')
      this.broadcast({
        seq: this.seq,
        type: 'RestApplied',
        payload: { voteId: vote.voteId, type: vote.type },
      } as ServerMessage);
    this.scheduleRestVoteTimer();
    if (trigger !== 'combat') await this.openRound();
  }

  rollDeathSave(accountId: string): Promise<void> {
    return this.enqueue(async () => {
      this.assertNotNarrating();
      this.requireBoundSeat(accountId);
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
      this.requireBoundSeat(accountId);
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

  private async commitCombatFallback(turnId: string): Promise<void> {
    const combat = roomGameState(this.state);
    if (!combat || combat.turnId !== turnId) return;
    const narration =
      'The tale pauses — the storyteller has lost the thread. Your action was not resolved; try again.';
    const narrationId = randomUUID();
    const events: Record<string, unknown>[] = [
      {
        type: 'NarrationCompleted',
        actionId: narrationId,
        narration,
        fallback: 'endpoint-error',
      },
      { type: 'TurnFallback', turnId, reason: 'endpoint-error' },
      { type: 'NarrationCommitted', turnId, narrationId },
    ];
    let nextCombat: RoomCombatState = {
      ...combat,
      narrationAttempts: 0,
      turnNarrationEvents: undefined,
      turnNarrationEventIds: undefined,
    };
    if (!combat.ended && combat.combat.activeEntityId) {
      const nextTurnId = randomUUID();
      const deadline = Date.now() + TURN_DEADLINE_MS;
      nextCombat = {
        ...nextCombat,
        phase: 'awaiting-command',
        turnId: nextTurnId,
        turnDeadline: deadline,
      };
      events.push({
        type: 'TurnOpened',
        turnId: nextTurnId,
        entityId: combat.combat.activeEntityId,
        deadline,
      });
    } else {
      delete nextCombat.phase;
      delete nextCombat.turnId;
      delete nextCombat.turnDeadline;
    }
    await this.commitGameState(
      {
        ...(this.state.gameState as Record<string, unknown>),
        combatRoom: nextCombat,
      },
      events,
    );
    const openedTurn = events.find((event) => event.type === 'TurnOpened');
    if (openedTurn) this.announceCombat(nextCombat, [openedTurn], undefined);
    this.broadcast({
      seq: this.seq,
      type: 'NarrationCompleted',
      payload: { turnId, text: narration },
    } as ServerMessage);
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
        payload: this.clientSyncPayload(),
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
      const vote = this.state.restVote;
      const now = Date.now();
      await this.persist('TablePaused', {
        paused,
        cause: paused ? 'host' : undefined,
        ...(vote && paused && vote.deadlineAt !== null
          ? { restVoteRemainingMs: Math.max(0, vote.deadlineAt - now) }
          : {}),
        ...(vote && !paused
          ? { restVoteDeadlineAt: now + (vote.remainingMs ?? 0) }
          : {}),
      });
      this.scheduleRestVoteTimer();
      if (paused) await this.freezeRoundTimer();
      else await this.resumeRoundTimer();
      this.broadcast({
        seq: this.seq,
        type: 'StateSync',
        payload: this.clientSyncPayload(),
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
        payload: this.clientSyncPayload(),
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
    kind: 'submit' | 'edit' | 'withdraw' | 'rest-vote' | 'host' | 'bind',
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
        this.sendSeatPrivateRoundSync(seat.accountId);
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
      this.sendSeatPrivateRoundSync(seat.accountId);
    }
  }

  private async openRound(): Promise<void> {
    const activeCombat = roomGameState(this.state);
    if (
      nextLateJoinBoundary({
        turnInFlight: this.turnInFlight,
        combatActive:
          !!activeCombat &&
          !activeCombat.ended &&
          !!activeCombat.combat?.activeEntityId,
        roundStatus: this.state.round?.status,
        sceneBoundary: this.sceneBoundaryPending,
      }) === 'before-next-turn'
    ) {
      this.sceneBoundaryPending = false;
      await this.admitApprovedLateJoins();
    }
    if (
      !this.state.roundsEnabled ||
      !this.state.gameState ||
      this.state.paused ||
      this.state.restVote
    )
      return;
    if (this.state.round?.status === 'open') return;
    const previousQueue = [...(this.state.round?.queuedSubmissions ?? [])].sort(
      (a, b) => a.receiptSeq - b.receiptSeq,
    );
    const round = {
      roundId: randomUUID(),
      status: 'open' as const,
      eligibleSeatIds: this.state.seats
        .filter(
          (seat) =>
            seat.presence !== 'away' &&
            seat.presence !== 'revoked' &&
            (!this.bindingEnforced || this.isPlayableSeat(seat)),
        )
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
    for (const seat of this.state.seats)
      this.sendSeatPrivateRoundSync(seat.accountId);
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
    if (round?.status === 'closing') {
      const reason =
        round.closeReason === 'resolve-now'
          ? 'timer'
          : (round.closeReason ?? 'timer');
      queueMicrotask(() => {
        void this.resolveRound(reason).catch(() => undefined);
      });
      return;
    }
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
      const reason =
        round.closeReason === 'resolve-now'
          ? 'timer'
          : (round.closeReason ?? 'timer');
      void this.resolveRound(reason).catch(() => undefined);
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

  requestLateJoin(
    accountId: string,
    characterId: string,
    expectedRevision: number,
    actionId: string,
    displayName = 'Player',
    matureOptOut = false,
    authTokenHash?: string,
  ): Promise<string> {
    return this.enqueue(async () => {
      if (this.state.ended) throw new LateJoinUnavailableError();
      const requestKey = `${accountId}:${actionId}`;
      const priorRequest = (this.state.lateJoinRequests ?? []).find(
        (request) =>
          request.accountId === accountId && request.actionId === actionId,
      );
      if (priorRequest) {
        if (priorRequest.characterId !== characterId)
          throw new LateJoinRequestConflictError();
        return priorRequest.requestId;
      }
      const priorResult = this.state.lateJoinRequestResults?.[requestKey];
      if (priorResult) {
        if (
          this.state.lateJoinRequestCharacterIds?.[requestKey] === characterId
        )
          return priorResult;
        throw new LateJoinRequestConflictError();
      }
      if (this.actionIds.has(actionId))
        throw new LateJoinRequestConflictError();
      if (
        this.state.seats.some(
          (seat) => seat.accountId === accountId && seat.presence !== 'revoked',
        )
      )
        throw new Error('Already seated');
      for (const request of this.state.lateJoinRequests ?? [])
        if (
          request.accountId === accountId &&
          (request.expiresAt === undefined || request.expiresAt <= Date.now())
        )
          await this.expireLateJoinRequestNow(request.requestId);
      const existing = (this.state.lateJoinRequests ?? []).find(
        (request) => request.accountId === accountId,
      );
      if (existing) {
        if (existing.characterId !== characterId)
          throw new LateJoinRequestConflictError();
        return existing.requestId;
      }
      if ((this.state.lateJoinRequests ?? []).length >= 3)
        throw new LateJoinLimitedError();
      if (
        this.state.seats.filter((seat) => seat.presence !== 'revoked').length >=
        6
      )
        throw new Error('Room is full');
      const character = await this.store.validateLateJoinCharacter?.(
        accountId,
        characterId,
        expectedRevision,
      );
      if (!character)
        throw new Error('Late join character validation unavailable');
      const request = {
        requestId: randomUUID(),
        expiresAt: Date.now() + LATE_JOIN_REQUEST_TTL_MS,
        accountId,
        characterId,
        expectedRevision,
        actionId,
        character,
        displayName,
        matureOptOut,
      };
      if (authTokenHash)
        this.lateJoinAuthTokenHashes.set(request.requestId, authTokenHash);
      await this.persist('LateJoinRequested', request, undefined, [actionId]);
      this.scheduleLateJoinExpiry(request.requestId, request.expiresAt);
      this.broadcast({
        seq: this.seq,
        type: 'StateSync',
        payload: this.clientSyncPayload(),
      });
      return request.requestId;
    });
  }

  approveLateJoin(
    accountId: string,
    actionId: string,
    requestId: string,
  ): Promise<void> {
    return this.enqueue(async () => {
      const actor = await this.requireHost(accountId);
      if (this.actionIds.has(actionId)) return;
      const request = this.state.lateJoinRequests?.find(
        (item) => item.requestId === requestId,
      );
      if (
        !request ||
        request.approved ||
        request.characterId === undefined ||
        request.expectedRevision === undefined
      )
        throw new RoomSeatRequiredError();
      if (request.expiresAt === undefined || request.expiresAt <= Date.now()) {
        await this.expireLateJoinRequestNow(requestId);
        return;
      }
      if (
        this.state.seats.filter((seat) => seat.presence !== 'revoked').length >=
        6
      )
        throw new Error('Room is full');
      await this.persist('LateJoinApproved', {
        requestId,
        actorSeatId: actor.seatId,
        actionId,
      });
      // Exploration admission waits for a committed SceneClosed event; combat uses the next initiative round.
      const combat = roomGameState(this.state);
      if (
        nextLateJoinBoundary({
          turnInFlight: this.turnInFlight,
          combatActive:
            !!combat && !combat.ended && !!combat.combat?.activeEntityId,
          roundStatus: this.state.round?.status,
          sceneBoundary: this.sceneBoundaryPending,
        }) === 'before-next-turn'
      ) {
        this.sceneBoundaryPending = false;
        await this.admitApprovedLateJoins();
      }
      this.broadcast({
        seq: this.seq,
        type: 'StateSync',
        payload: this.clientSyncPayload(),
      });
    });
  }

  requestSeatResumeClaim(accountId: string, claimId: string): Promise<boolean> {
    return this.enqueue(async () => {
      const seat = this.state.seats.find(
        (candidate) => candidate.accountId === accountId,
      );
      if (
        !seat ||
        seat.presence === 'revoked' ||
        this.connections.has(accountId)
      )
        throw new RoomSeatRequiredError();
      if (
        [...this.seatClaims.values()].some(
          (claim) => claim.seatId === seat.seatId,
        )
      )
        throw new Error('A seat claim is already pending');
      let decide!: (approved: boolean) => void;
      const result = new Promise<boolean>((resolve) => {
        decide = resolve;
      });
      const expiresAt = Date.now() + SEAT_CLAIM_TTL_MS;
      const timer = setTimeout(() => {
        void this.expireSeatResumeClaim(claimId);
      }, SEAT_CLAIM_TTL_MS);
      timer.unref?.();
      this.seatClaims.set(claimId, {
        claimId,
        accountId,
        seatId: seat.seatId,
        displayName: seat.displayName,
        expiresAt,
        timer,
        decide,
      });
      this.broadcast({
        seq: this.seq,
        type: 'SeatClaimRequested',
        payload: {
          claimId,
          seatId: seat.seatId,
          displayName: seat.displayName,
          expiresAt,
        },
      });
      return { result };
    }).then(({ result }) => result);
  }

  approveSeatResumeClaim(
    accountId: string,
    actionId: string,
    claimId: string,
  ): Promise<void> {
    return this.enqueue(async () => {
      if (this.actionIds.has(actionId)) return;
      await this.requireHost(accountId);
      const claim = this.seatClaims.get(claimId);
      if (
        !claim ||
        claim.expiresAt <= Date.now() ||
        this.connections.has(claim.accountId)
      )
        throw new RoomSeatRequiredError();
      clearTimeout(claim.timer);
      this.seatClaims.delete(claimId);
      claim.decide(true);
      this.broadcast({
        seq: this.seq,
        type: 'SeatClaimApproved',
        payload: { claimId, actionId },
      });
    });
  }

  denySeatResumeClaim(
    accountId: string,
    actionId: string,
    claimId: string,
  ): Promise<void> {
    return this.enqueue(async () => {
      if (this.actionIds.has(actionId)) return;
      await this.requireHost(accountId);
      const claim = this.seatClaims.get(claimId);
      if (!claim) throw new RoomSeatRequiredError();
      clearTimeout(claim.timer);
      this.seatClaims.delete(claimId);
      claim.decide(false);
      this.broadcast({
        seq: this.seq,
        type: 'SeatClaimDenied',
        payload: { claimId, actionId },
      });
    });
  }

  cancelSeatResumeClaim(claimId: string): Promise<void> {
    return this.enqueue(async () => {
      const claim = this.seatClaims.get(claimId);
      if (!claim) return;
      clearTimeout(claim.timer);
      this.seatClaims.delete(claimId);
      claim.decide(false);
      this.broadcast({
        seq: this.seq,
        type: 'SeatClaimExpired',
        payload: { claimId },
      });
    });
  }

  private expireSeatResumeClaim(claimId: string): Promise<void> {
    return this.enqueue(async () => {
      const claim = this.seatClaims.get(claimId);
      if (!claim) return;
      this.seatClaims.delete(claimId);
      claim.decide(false);
      this.broadcast({
        seq: this.seq,
        type: 'SeatClaimExpired',
        payload: { claimId },
      });
    });
  }

  denyLateJoin(
    accountId: string,
    actionId: string,
    requestId: string,
  ): Promise<void> {
    return this.enqueue(async () => {
      const actor = await this.requireHost(accountId);
      if (this.actionIds.has(actionId)) {
        const replayMatchesRequest = Object.entries(
          this.state.lateJoinRequestResults ?? {},
        ).some(
          ([key, resultRequestId]) =>
            key.endsWith(`:${actionId}`) && resultRequestId === requestId,
        );
        if (
          this.state.lateJoinActionOwners?.[actionId] === accountId &&
          replayMatchesRequest
        )
          return;
        throw new RoomSeatRequiredError();
      }
      const request = this.state.lateJoinRequests?.find(
        (item) => item.requestId === requestId,
      );
      if (!request) throw new RoomSeatRequiredError();
      if (request.expiresAt === undefined || request.expiresAt <= Date.now()) {
        await this.expireLateJoinRequestNow(requestId);
        return;
      }
      const pendingSeat = this.state.seats.find(
        (seat) => seat.accountId === request.accountId,
      );
      if (pendingSeat) {
        const connection = this.connections.get(pendingSeat.accountId);
        this.connections.delete(pendingSeat.accountId);
        await this.withdrawSeatActions(pendingSeat);
        await this.persist('SeatRevoked', {
          seatId: pendingSeat.seatId,
          accountId: pendingSeat.accountId,
          actorSeatId: actor.seatId,
          actorAccountId: accountId,
          cause: 'late-join-declined',
        });
        connection?.close?.(1008, 'Late join declined');
      }
      await this.persist('LateJoinDenied', {
        requestId,
        actorSeatId: actor.seatId,
        actorAccountId: accountId,
        actionId,
      });
      this.lateJoinAuthTokenHashes.delete(requestId);
      const timer = this.lateJoinExpiryTimers.get(requestId);
      if (timer) clearTimeout(timer);
      this.lateJoinExpiryTimers.delete(requestId);
      this.broadcast({
        seq: this.seq,
        type: 'StateSync',
        payload: this.clientSyncPayload(),
      });
    });
  }

  cancelLateJoin(
    accountId: string,
    actionId: string,
    requestId: string,
  ): Promise<void> {
    return this.enqueue(async () => {
      const request = this.state.lateJoinRequests?.find(
        (item) => item.requestId === requestId,
      );
      const replayRequestId =
        this.state.lateJoinRequestResults?.[`${accountId}:${actionId}`];
      if (
        (!request || request.accountId !== accountId) &&
        replayRequestId !== requestId
      )
        throw new RoomSeatRequiredError();
      if (this.actionIds.has(actionId)) {
        if (
          this.state.lateJoinActionOwners?.[actionId] === accountId &&
          replayRequestId === requestId
        )
          return;
        throw new RoomSeatRequiredError();
      }
      if (!request || request.accountId !== accountId)
        throw new RoomSeatRequiredError();
      if (request.expiresAt === undefined || request.expiresAt <= Date.now()) {
        await this.expireLateJoinRequestNow(requestId);
        return;
      }
      const seat = this.state.seats.find(
        (item) => item.accountId === accountId,
      );
      if (seat) {
        const connection = this.connections.get(accountId);
        this.connections.delete(accountId);
        await this.withdrawSeatActions(seat);
        await this.persist('SeatRevoked', {
          seatId: seat.seatId,
          accountId,
          cause: 'late-join-cancelled',
        });
        connection?.close?.(1008, 'Late join cancelled');
      }
      await this.persist(
        'LateJoinCancelled',
        {
          requestId,
          actionId,
          actorAccountId: accountId,
        },
        undefined,
        [actionId],
      );
      this.lateJoinAuthTokenHashes.delete(requestId);
      const timer = this.lateJoinExpiryTimers.get(requestId);
      if (timer) clearTimeout(timer);
      this.lateJoinExpiryTimers.delete(requestId);
      this.broadcast({
        seq: this.seq,
        type: 'StateSync',
        payload: this.clientSyncPayload(),
      });
    });
  }

  private async admitApprovedLateJoins(): Promise<void> {
    const approved = (this.state.lateJoinRequests ?? []).filter(
      (request) => request.approved,
    );
    for (const request of approved) {
      if (
        request.characterId === undefined ||
        request.expectedRevision === undefined
      )
        continue;
      if (
        this.store.isAccountActive &&
        !(await this.store.isAccountActive(request.accountId))
      )
        continue;
      let seat = this.state.seats.find(
        (item) => item.accountId === request.accountId,
      );
      if (!seat) {
        if (
          this.state.seats.filter((item) => item.presence !== 'revoked')
            .length >= 6
        )
          break;
        seat = {
          seatId: randomUUID() as Seat['seatId'],
          accountId: request.accountId,
          displayName: request.displayName,
          presence: 'returning' as const,
          isHost: false,
          chatMuted: false,
          chatMutedUntil: null,
          matureOptOut: request.matureOptOut ?? false,
        };
        await this.persist('SeatJoined', seat);
        const resumeToken = await this.store.createSeatResumeToken?.(
          this.sessionId,
          seat.seatId,
        );
        const authTokenHash = this.lateJoinAuthTokenHashes.get(
          request.requestId,
        );
        if (resumeToken && authTokenHash)
          this.setPendingSeatResumeToken(
            request.accountId,
            resumeToken,
            authTokenHash,
          );
      }
      if (!seat) continue;
      if (!this.seatBindings.has(seat.seatId)) {
        try {
          await this.persist(
            'SeatCharacterBound',
            { seatId: seat.seatId },
            {
              kind: 'bind',
              seatId: seat.seatId,
              accountId: request.accountId,
              characterId: request.characterId,
              expectedRevision: request.expectedRevision,
            },
          );
        } catch (error) {
          if (!(error instanceof SeatCharacterError)) throw error;
          await this.persist('SeatRevoked', {
            seatId: seat.seatId,
            accountId: seat.accountId,
            cause: 'late-join-selection-invalid',
          });
          await this.persist('LateJoinExpired', {
            requestId: request.requestId,
            reason: 'selection-unavailable',
          });
          this.lateJoinAuthTokenHashes.delete(request.requestId);
          const timer = this.lateJoinExpiryTimers.get(request.requestId);
          if (timer) clearTimeout(timer);
          this.lateJoinExpiryTimers.delete(request.requestId);
          continue;
        }
      }
      const binding = this.seatBindings.get(seat.seatId);
      const game = this.state.gameState as Record<string, unknown> | undefined;
      const engine = game?.gameEngine as Record<string, unknown> | undefined;
      const combatRoom = game?.combatRoom as RoomCombatState | undefined;
      const map = (combatRoom?.map ?? engine?.map) as
        | import('@game/schema').Battlemap
        | undefined;
      if (!binding || !game || !map) continue;
      const rawEntities =
        combatRoom?.entities ??
        (engine?.entities as Array<Record<string, unknown>> | undefined) ??
        [];
      const occupants = rawEntities.flatMap((entity) => {
        const pos = entity.pos as { x?: unknown; y?: unknown } | undefined;
        if (
          !pos ||
          typeof pos.x !== 'number' ||
          typeof pos.y !== 'number' ||
          typeof entity.id !== 'string'
        )
          return [];
        return [
          {
            id: entity.id,
            team: typeof entity.team === 'string' ? entity.team : 'party',
            size: typeof entity.size === 'number' ? entity.size : 1,
            pos: { x: pos.x, y: pos.y },
          },
        ];
      });
      const pos = lateJoinSpawnCell(map, occupants);
      const sceneId =
        (typeof game.sceneId === 'string' && game.sceneId) ||
        (typeof game.currentSceneId === 'string' && game.currentSceneId);
      if (!pos || !sceneId) continue;
      const entityId = seatEntityId(seat.seatId);
      const character = {
        ...(binding.characterSnapshot as unknown as CharacterInput),
        id: entityId,
      };
      const catalog = loadCatalog();
      const sheet = deriveSheet(character, catalog);
      const engineEntity = {
        id: entityId,
        name: character.name,
        team: 'party',
        pos,
        size: 1,
        hp: character.hp.current,
        maxHp: sheet.maxHp,
        ac: sheet.ac,
        speed: 30,
      };
      const gameEngine = {
        ...(engine ?? {}),
        actors: {
          ...((engine?.actors as Record<string, unknown> | undefined) ?? {}),
          [seat.seatId]: character,
        },
        ...(Array.isArray(engine?.entities)
          ? { entities: [...engine.entities, engineEntity] }
          : {}),
      };
      let initiativeEvent:
        | { type: string; payload: Record<string, unknown> }
        | undefined;
      let nextCombatRoom = combatRoom;
      let initiativeEffectiveRound: number | undefined;
      if (combatRoom && !combatRoom.ended) {
        const [die, seed] = nextDie(combatRoom.seed ?? 1, 20);
        const total = die + sheet.initiative;
        const initiative = [...combatRoom.combat.initiative];
        const activeIndex = initiative.findIndex(
          (entry) => entry.entityId === combatRoom.combat.activeEntityId,
        );
        initiative.splice(
          activeIndex < 0 ? initiative.length : activeIndex,
          0,
          {
            entityId,
            total,
          },
        );
        const attackData = attacksFor(
          { ...engineEntity, hp: character.hp.current },
          character,
          (engine?.attacks as Record<string, never> | undefined) ?? {},
          catalog,
        );
        nextCombatRoom = {
          ...combatRoom,
          entities: [
            ...combatRoom.entities,
            {
              ...engineEntity,
              kind: 'character',
              abilities: character.abilities,
              saves: attackData.saves,
              attacks: attackData.attacks,
            },
          ],
          combat: {
            ...combatRoom.combat,
            initiative,
            resources: {
              ...combatRoom.combat.resources,
              [entityId]: {
                action: true,
                bonusAction: true,
                reaction: true,
                movementRemaining: 30,
              },
            },
          },
          seed,
        };
        initiativeEffectiveRound = combatRoom.combat.round + 1;
        initiativeEvent = {
          type: 'InitiativeRolled',
          payload: { entityId, total },
        };
      }
      const gameState = {
        ...game,
        characters: {
          ...((game.characters as Record<string, unknown> | undefined) ?? {}),
          [seat.seatId]: character,
        },
        gameEngine,
        ...(nextCombatRoom ? { combatRoom: nextCombatRoom } : {}),
      };
      const turnId = randomUUID();
      const eventInputs = [
        { type: 'EntityPlaced', payload: { entityId, pos } },
        ...(initiativeEvent ? [initiativeEvent] : []),
        {
          type: 'LateJoinSpawned',
          payload: {
            seatId: seat.seatId,
            entityId,
            sceneId,
            pos,
            ...(initiativeEffectiveRound !== undefined
              ? { initiativeEffectiveRound }
              : {}),
          },
        },
        {
          type: 'LateJoinAdmitted',
          payload: { requestId: request.requestId, seatId: seat.seatId },
        },
      ];
      // `LateJoinAdmitted` is the final event in this atomic event batch; reduceRoom receives
      // that final seq while writeTurn numbers every preceding spawn event from the old head.
      const nextState = reduceRoom(this.state, {
        sessionId: this.sessionId,
        seq: this.seq + eventInputs.length,
        turnId,
        type: 'LateJoinAdmitted',
        payload: { requestId: request.requestId, seatId: seat.seatId },
        ts: new Date(),
      });
      const stored = await this.writeTurn(
        this.sessionId,
        eventInputs.map((event, index) => ({
          seq: this.seq + index + 1,
          turnId,
          type: event.type,
          payload: event.payload,
        })),
        { ...nextState, gameState },
        this.lease,
      );
      this.seq = stored.events.at(-1)?.seq ?? this.seq;
      this.state = RoomStateSchema.parse({ ...nextState, gameState });
      this.lateJoinAuthTokenHashes.delete(request.requestId);
      const expiryTimer = this.lateJoinExpiryTimers.get(request.requestId);
      if (expiryTimer) clearTimeout(expiryTimer);
      this.lateJoinExpiryTimers.delete(request.requestId);
      this.broadcast({
        seq: this.seq,
        type: 'StateSync',
        payload: this.clientSyncPayload(),
      });
    }
  }

  private clearPresenceTimer(seatId: string): void {
    const timer = this.presenceTimers.get(seatId);
    if (timer) clearTimeout(timer);
    this.presenceTimers.delete(seatId);
  }

  private schedulePresenceTransition(
    seatId: Seat['seatId'],
    presence: 'connected' | 'away',
    delayMs: number,
  ): void {
    this.clearPresenceTimer(seatId);
    const timer = setTimeout(() => {
      void this.enqueue(async () => {
        const seat = this.state.seats.find((item) => item.seatId === seatId);
        if (!seat) return;
        if (presence === 'connected' && seat.presence !== 'returning') return;
        if (presence === 'away' && seat.presence !== 'disconnected') return;
        await this.transitionPresence(
          seatId,
          presence,
          presence === 'away' ? 'SeatAway' : 'PresenceChanged',
          presence === 'away' ? { at: Date.now() } : {},
        );
        if (presence === 'connected') {
          this.disconnectedAt.delete(seatId);
          this.disconnectedMs.delete(seatId);
        }
        await this.reconcileConnectionPause();
        if (presence === 'connected') await this.ensureRoundOpen();
      }).catch(() => undefined);
    }, delayMs);
    timer.unref?.();
    this.presenceTimers.set(seatId, timer);
  }

  private async reconcileConnectionPause(): Promise<void> {
    const confirmed = this.state.seats.some(
      (seat) => seat.presence === 'connected',
    );
    if (!confirmed && !this.state.paused) {
      await this.persist('TablePaused', {
        paused: true,
        cause: 'no-connected-seats',
      });
      await this.freezeRoundTimer();
      this.broadcast({
        seq: this.seq,
        type: 'StateSync',
        payload: { ...this.clientSyncPayload(), state: this.clientState() },
      });
    } else if (
      confirmed &&
      this.state.paused &&
      this.state.pauseCause === 'no-connected-seats'
    ) {
      await this.persist('TablePaused', { paused: false });
      await this.resumeRoundTimer();
      this.broadcast({
        seq: this.seq,
        type: 'StateSync',
        payload: { ...this.clientSyncPayload(), state: this.clientState() },
      });
      this.kickQueue();
    }
  }

  setSystemChatMute(
    seatId: string,
    muted: boolean,
    mutedUntil = Date.now() + 5 * 60_000,
  ): Promise<void> {
    return this.enqueue(async () => {
      const target = this.state.seats.find((seat) => seat.seatId === seatId);
      if (!target || target.chatMuted === muted) return;
      await this.persist('ChatMuteChanged', {
        seatId,
        muted,
        mutedUntil: muted ? mutedUntil : null,
        source: 'automatic',
      });
      this.broadcast({
        seq: this.seq,
        type: 'StateSync',
        payload: this.clientSyncPayload(),
      });
    });
  }

  private async requireHost(
    accountId: string,
  ): Promise<RoomState['seats'][number]> {
    const actor = this.state.seats.find((seat) => seat.accountId === accountId);
    if (
      !actor ||
      !this.store.isTableHost ||
      !(await this.store.isTableHost(this.sessionId, accountId))
    )
      throw new NotTableHostError();
    return actor;
  }

  kickSeat(accountId: string, actionId: string, seatId: string): Promise<void> {
    return this.enqueue(async () => {
      if (this.actionIds.has(actionId)) return;
      const actor = await this.requireHost(accountId);
      const target = this.state.seats.find((seat) => seat.seatId === seatId);
      if (!target || target.seatId === actor.seatId)
        throw new RoomSeatRequiredError();
      const connection = this.connections.get(target.accountId);
      this.connections.delete(target.accountId);
      await this.withdrawSeatActions(target);
      await this.persist('SeatRevoked', {
        seatId: target.seatId,
        accountId: target.accountId,
        actorSeatId: actor.seatId,
        actorAccountId: accountId,
        cause: 'host-kick',
        actionId,
      });
      this.afterSeatReleased();
      this.broadcast({
        seq: this.seq,
        type: 'StateSync',
        payload: this.clientSyncPayload(),
      });
      connection?.close?.(1008, 'Seat revoked by the host');
    });
  }

  transferHost(
    accountId: string,
    actionId: string,
    seatId: string,
  ): Promise<void> {
    return this.enqueue(async () => {
      if (this.actionIds.has(actionId)) return;
      await this.requireHost(accountId);
      const target = this.state.seats.find((seat) => seat.seatId === seatId);
      if (!target) throw new RoomSeatRequiredError();
      if (target.accountId === accountId) return;
      if (!this.store.transferTableHost)
        throw new Error('Host transfer unavailable');
      await this.store.transferTableHost(
        this.sessionId,
        accountId,
        target.accountId,
      );
      await this.persist('HostTransferred', {
        fromAccountId: accountId,
        toAccountId: target.accountId,
        actionId,
        fromSeatId: this.state.seats.find((s) => s.accountId === accountId)
          ?.seatId,
        toSeatId: seatId,
      });
      this.broadcast({
        seq: this.seq,
        type: 'StateSync',
        payload: this.clientSyncPayload(),
      });
    });
  }

  setChatMute(
    accountId: string,
    actionId: string,
    seatId: string,
    muted: boolean,
  ): Promise<void> {
    return this.enqueue(async () => {
      if (this.actionIds.has(actionId)) return;
      const actor = await this.requireHost(accountId);
      const target = this.state.seats.find((seat) => seat.seatId === seatId);
      if (!target || (target.seatId === actor.seatId && muted))
        throw new RoomSeatRequiredError();
      if (target.chatMuted === muted) return;
      await this.persist('ChatMuteChanged', {
        seatId,
        muted,
        mutedUntil: null,
        actorSeatId: actor.seatId,
        actionId,
      });
      this.broadcast({
        seq: this.seq,
        type: 'StateSync',
        payload: this.clientSyncPayload(),
      });
    });
  }

  endTable(accountId: string, actionId: string): Promise<void> {
    return this.enqueue(async () => {
      if (this.actionIds.has(actionId)) return;
      const actor = await this.requireHost(accountId);
      await this.store.endTable?.(this.sessionId);
      await this.persist('TableEnded', {
        actorSeatId: actor.seatId,
        actorAccountId: accountId,
        actionId,
      });
      this.broadcast({
        seq: this.seq,
        type: 'StateSync',
        payload: this.clientSyncPayload(),
      });
      for (const connection of this.connections.values())
        connection.close?.(1000, 'Table ended by host');
      this.connections.clear();
    });
  }

  configureRoundTimer(
    accountId: string,
    durationMs: number | null,
    actionId: string = randomUUID(),
  ): Promise<void> {
    return this.enqueue(async () => {
      if (this.actionIds.has(actionId)) return;
      if (
        durationMs !== null &&
        (!Number.isInteger(durationMs) ||
          durationMs < 30_000 ||
          durationMs > 600_000)
      )
        throw new Error('Round timer must be between 30 and 600 seconds');
      if (
        !this.store.isTableHost ||
        !(await this.store.isTableHost(this.sessionId, accountId))
      )
        throw new NotTableHostError('Only the table host can configure rounds');
      await this.persist('RoundTimerConfigured', { durationMs, actionId });
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
          this.requireBoundSeat(requesterAccountId);
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
        const currentlyBoundSeatIds = new Set(
          this.state.seats
            .filter(
              (seat) => !this.bindingEnforced || this.isPlayableSeat(seat),
            )
            .map((seat) => seat.seatId),
        );
        const batch = [...(this.state.round?.submissions ?? [])]
          .filter((submission) => currentlyBoundSeatIds.has(submission.seatId))
          .sort((a, b) => a.receiptSeq - b.receiptSeq);
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
        // Departure withdrawals are the primary path; enforce current binding again at close.
        // Re-check eligibility at close; accepted submissions from seats that became away stay in the batch.
        const closeReason = round.closeReason ?? reason;
        await this.persist('RoundResolved', {
          roundId: round.roundId,
          closeReason,
          actions: batch,
        });
        this.broadcast({
          seq: this.seq,
          type: 'RoundResolved',
          payload: {
            roundId: round.roundId,
            closeReason,
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
      this.assertSeatBound(seat);
      if (!this.turnRunner) throw new Error('Solo turn runner unavailable');
      if (receiptSeq !== undefined)
        this.completedActionDecisions.delete(receiptSeq);
      if (this.hasActionId(actionId, receiptSeq, accountId)) return false;
      await this.ensureRoundOpen();
      const round = this.state.round;
      if (!round) return false;
      const currentSubmissions = round.submissions;
      const queued =
        !!this.state.restVote ||
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
      this.sendSeatPrivateRoundSync(accountId);
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
      this.assertSeatBound(seat);
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
      this.requireBoundSeat(accountId);
      if (receiptSeq !== undefined)
        this.completedActionDecisions.delete(receiptSeq);
      if (this.hasActionId(actionId, receiptSeq, accountId)) return 'duplicate';
      const round = this.state.round;
      if (!round) return 'unknown_submission';
      if (
        round.status !== 'open' &&
        round.status !== 'resolving' &&
        !this.state.restVote
      )
        return 'round_closed';
      const queued = !!this.state.restVote || round.status === 'resolving';
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
      this.sendSeatPrivateRoundSync(accountId);
      return 'edited';
    });
  }

  answerClarification(
    accountId: string,
    actionId: string,
    answer: string,
  ): Promise<boolean> {
    return this.enqueuePlayer(async () => {
      let seat: Seat;
      try {
        seat = this.requireBoundSeat(accountId);
      } catch {
        return false;
      }
      const open = this.state.openClarifications?.[actionId];
      if (
        !open ||
        open.accountId !== accountId ||
        !this.state.seats.some((current) => current.seatId === seat.seatId)
      )
        return false;
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
      this.requireBoundSeat(accountId);
      if (this.hasActionId(commandActionId, undefined, accountId))
        return 'duplicate';
      if (!this.reserveActionMutation(accountId, 'withdraw')) return 'limited';
      const round = this.state.round;
      if (round) {
        if (round.status === 'closing') return 'round_closed';
        const queued = !!this.state.restVote || round.status === 'resolving';
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
        this.sendSeatPrivateRoundSync(accountId);
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
        if (action.combatTurnId) {
          const combat = roomGameState(this.state);
          if (!combat || combat.turnId !== action.combatTurnId) {
            this.pendingActions.delete(action.actionId);
            continue;
          }
          if ((combat.narrationAttempts ?? 0) >= 2) {
            await this.commitCombatFallback(action.combatTurnId);
            this.pendingActions.delete(action.actionId);
            continue;
          }
          const nextCombat = {
            ...combat,
            narrationAttempts: (combat.narrationAttempts ?? 0) + 1,
          };
          const gameState = {
            ...(this.state.gameState as Record<string, unknown>),
            combatRoom: nextCombat,
          };
          await this.commitGameState(gameState, [
            {
              type: 'NarrationAttemptStarted',
              turnId: action.combatTurnId,
              attempt: nextCombat.narrationAttempts,
            },
          ]);
        }
        await this.resolveTurn(
          action.accountId,
          action.actionId,
          action.text,
          action.playerName,
          action.clarificationAsked === true,
          undefined,
          action.combatTurnId,
        );
        if (this.sceneBoundaryPending)
          await this.enqueue(async () => {
            this.sceneBoundaryPending = false;
            await this.admitApprovedLateJoins();
          });
      } catch (error) {
        if (action.combatTurnId) {
          // A combat narration failure must not leave the resolved turn open.
          // The engine-written ADR-022 fallback is the committed narration.
          await this.commitCombatFallback(action.combatTurnId);
          this.pendingActions.delete(action.actionId);
          continue;
        }
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
    this.queueAwayAutopilot();
  }

  private async withdrawSeatActions(seat: Seat): Promise<void> {
    const round = this.state.round;
    const submission = round?.submissions.find(
      (item) => item.seatId === seat.seatId,
    );
    if (round && submission) {
      const commandActionId = randomUUID();
      await this.persist('RoundActionWithdrawn', {
        roundId: round.roundId,
        seatId: seat.seatId,
        accountId: seat.accountId,
        commandActionId,
        actionId: submission.actionId,
        queued: false,
      });
      for (const id of submission.actionIds) this.pendingActions.delete(id);
      this.broadcast({
        seq: this.seq,
        type: 'RoundActionWithdrawn',
        payload: { roundId: round.roundId, seatId: seat.seatId },
      } as ServerMessage);
    }
    for (const [actionId, clarification] of Object.entries(
      this.state.openClarifications ?? {},
    )) {
      if (clarification.accountId !== seat.accountId) continue;
      this.pendingActions.delete(actionId);
      await this.closeClarification(actionId, 'expired');
      this.broadcast({
        seq: this.seq,
        type: 'ActionWithdrawn',
        payload: { actionId },
      } as ServerMessage);
    }
    this.withdrawQueuedFor(seat.accountId);
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
    combatTurnId?: string,
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
          lastRestVoteResult: this.state.lastRestVoteResult,
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
      if (result.fallback !== 'endpoint-error' || combatTurnId) {
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
        const writes: EventInput[] = result.events
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
        const restRequest = result.fallback
          ? undefined
          : (result.events.find(
              (event) =>
                (event as { type?: string }).type === 'RestVoteRequested',
            ) as { kind?: 'short' | 'long' } | undefined);
        for (let index = writes.length - 1; index >= 0; index--)
          if (writes[index]?.type === 'RestVoteRequested')
            writes.splice(index, 1);
        const combatStartAt = result.events.findIndex(
          (event) => (event as { type?: string }).type === 'CombatStarted',
        );
        if (combatStartAt >= 0 && this.state.restVote) {
          const closePayload = {
            voteId: this.state.restVote.voteId,
            ...cancelRestVoteForCombat(),
          };
          const insertAt = writes.findIndex(
            (write) => write.type === 'CombatStarted',
          );
          writes.splice(insertAt < 0 ? 0 : insertAt, 0, {
            seq: undefined,
            turnId: id,
            type: 'RestVoteClosed',
            payload: closePayload,
          });
          clearTimeout(this.restVoteTimer);
        }
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
            payload: { actionId, accountId },
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
        if (restRequest?.kind) {
          const openEvent = this.buildRestVoteOpenEvent(
            id,
            restRequest.kind,
            roundId,
          );
          if (openEvent) writes.push(openEvent);
        }
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
        const reconciled = this.combatRuntime.reconcile(
          incoming,
          Date.now(),
          this.bindingEnforced ? this.seatBindings : undefined,
        );
        const combatEvents = [
          ...(hurt?.events ?? []),
          ...(reconciled?.events ?? []),
        ];
        let turnGameState = reconciled?.gameState ?? incoming;
        const initialCombat = (
          turnGameState as { combatRoom?: RoomCombatState }
        ).combatRoom;
        if (
          combatEvents.some((event) => event.type === 'CombatStarted') &&
          initialCombat &&
          !initialCombat.pendingReaction &&
          initialCombat.combat.activeEntityId
        ) {
          const openedId = randomUUID();
          const deadline = Date.now() + TURN_DEADLINE_MS;
          turnGameState = {
            ...turnGameState,
            combatRoom: {
              ...initialCombat,
              phase: 'awaiting-command',
              turnId: openedId,
              narrationAttempts: 0,
              turnDeadline: deadline,
            },
          };
          combatEvents.push({
            type: 'TurnOpened',
            turnId: openedId,
            entityId: initialCombat.combat.activeEntityId,
            deadline,
          });
        }
        let openedTurn: Record<string, unknown> | undefined;
        if (combatTurnId) {
          const combatRoom = (turnGameState as { combatRoom?: RoomCombatState })
            .combatRoom;
          if (combatRoom?.turnId === combatTurnId) {
            if (combatRoom.ended) {
              const completedCombat = { ...combatRoom };
              delete completedCombat.phase;
              delete completedCombat.turnId;
              delete completedCombat.turnDeadline;
              completedCombat.narrationAttempts = 0;
              completedCombat.turnNarrationEvents = undefined;
              completedCombat.turnNarrationEventIds = undefined;
              turnGameState = {
                ...turnGameState,
                combatRoom: completedCombat,
              };
            } else if (combatRoom.pendingReaction) {
              turnGameState = {
                ...turnGameState,
                combatRoom: { ...combatRoom, phase: 'reaction-pending' },
              };
            } else {
              const nextTurnId = randomUUID();
              const deadline = Date.now() + TURN_DEADLINE_MS;
              const nextCombat = {
                ...combatRoom,
                phase: 'awaiting-command' as const,
                turnId: nextTurnId,
                narrationAttempts: 0,
                turnDeadline: deadline,
                turnNarrationEvents: undefined,
                turnNarrationEventIds: undefined,
              };
              turnGameState = { ...turnGameState, combatRoom: nextCombat };
              openedTurn = {
                type: 'TurnOpened',
                turnId: nextTurnId,
                entityId: nextCombat.combat.activeEntityId,
                deadline,
              };
            }
          }
        }
        for (const event of combatEvents)
          writes.push({
            seq: undefined,
            turnId: id,
            type: String(event.type),
            payload: event,
          });
        if (combatTurnId) {
          writes.push({
            seq: undefined,
            turnId: combatTurnId,
            type: 'NarrationCommitted',
            payload: { turnId: combatTurnId, narrationId: actionId },
          });
          if (openedTurn)
            writes.push({
              seq: undefined,
              turnId: combatTurnId,
              type: 'TurnOpened',
              payload: openedTurn,
            });
        }
        const deadlineAt = Date.now() + CLARIFICATION_TIMEOUT_MS;
        const restVoteClosePayload = writes.find(
          (write) => write.type === 'RestVoteClosed',
        )?.payload as
          | {
              outcome: 'passed' | 'failed';
              closeReason: NonNullable<
                RoomState['lastRestVoteResult']
              >['closeReason'];
            }
          | undefined;
        const nextState = {
          ...this.state,
          gameState: settleEngine(turnGameState),
          ...(!clarification
            ? {
                spotlightActivity: {
                  ...(this.state.spotlightActivity ?? {}),
                  [accountId]: this.state.spotlightTurn ?? 0,
                },
              }
            : {}),
          ...(writes.some((write) => write.type === 'RestVoteClosed')
            ? {
                restVote: undefined,
                restVoteLastClosedAt: Date.now(),
                ...(this.state.restVote && {
                  lastRestVoteResult: {
                    voteId: this.state.restVote.voteId,
                    type: this.state.restVote.type,
                    outcome: restVoteClosePayload!.outcome,
                    closeReason: restVoteClosePayload!.closeReason,
                  },
                  lastRestVoteResultTurnId: id,
                }),
              }
            : {}),
          ...(writes.find((write) => write.type === 'RestVoteOpened')
            ? {
                restVoteCount: (this.state.restVoteCount ?? 0) + 1,
                restVote: {
                  ...(writes.find((write) => write.type === 'RestVoteOpened')!
                    .payload as NonNullable<RoomState['restVote']>),
                  ballots: [],
                  castSeatIds: [],
                },
              }
            : {}),
          ...(roundId && this.state.round?.roundId === roundId
            ? { round: { ...this.state.round, status: 'resolved' as const } }
            : {}),
          ...(this.state.lastRestVoteResult &&
            this.state.lastRestVoteResultTurnId !== id &&
            !writes.some((write) => write.type === 'RestVoteClosed') && {
              lastRestVoteResult: undefined,
              lastRestVoteResultTurnId: undefined,
            }),
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
        if (stored.events.some((event) => event.type === 'SceneClosed'))
          this.sceneBoundaryPending = true;
        if (openedTurn) combatEvents.push(openedTurn as never);
        const opened = stored.events.find(
          (event) => event.type === 'RestVoteOpened',
        );
        if (opened) {
          this.broadcast({
            seq: opened.seq,
            type: 'RestVoteOpened',
            payload: {
              voteId: (opened.payload as { voteId: string }).voteId,
              type: (opened.payload as { type: 'short' | 'long' }).type,
              deadlineAt: (opened.payload as { deadlineAt: number }).deadlineAt,
            },
          } as ServerMessage);
          this.scheduleRestVoteTimer();
        }
        const cancelled = stored.events.find(
          (event) =>
            event.type === 'RestVoteClosed' &&
            (event.payload as { closeReason?: string }).closeReason ===
              'cancelled-combat',
        );
        if (cancelled)
          this.broadcast({
            seq: cancelled.seq,
            type: 'RestVoteClosed',
            payload: cancelled.payload as Record<string, unknown>,
          } as ServerMessage);
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
        if (narrationEvent && !clarification)
          await this.deliverSpotlightPrompt();
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
      this.assertSeatBound(seat);
      if (this.actionIds.has(actionId)) return false;
      const current = roomGameState(this.state);
      const gameState = this.state.gameState as
        | {
            combatActors?: Record<string, string>;
            characters?: Record<string, never>;
          }
        | undefined;
      // Bound seats act only as their own server-derived entity; the client never names one.
      const candidate = this.seatBindings.get(seat.seatId);
      const bound =
        candidate?.accountId === seat.accountId ? candidate : undefined;
      const actorId = bound
        ? seatEntityId(seat.seatId)
        : gameState?.combatActors?.[accountId];
      if (
        !current ||
        !actorId ||
        (bound && !current.entities.some((entity) => entity.id === actorId))
      ) {
        this.sendError(
          accountId,
          'COMMAND_REJECTED',
          'Combat is not active for this player.',
          actionId,
        );
        return true;
      }
      const result = this.combatRuntime.execute(current, actorId, command, {
        character: bound
          ? ({ ...bound.characterSnapshot, id: actorId } as never)
          : gameState?.characters?.[accountId],
        now: Date.now(),
      });
      if ('code' in result) {
        this.sendError(accountId, result.code, result.message, actionId);
        return true;
      }
      // Ask the combat admission table first. Its authorization-first result is
      // stable even while an asynchronous narration is in flight.
      if (this.turnInFlight) {
        this.sendError(
          accountId,
          'COMMAND_REJECTED',
          'The DM is still narrating; try again in a moment.',
          actionId,
        );
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
    const beforeCombat = roomGameState(this.state);
    const resolved =
      result.events.some((event) => event.type === 'TurnEnded') ||
      result.events.some((event) => event.type === 'CombatEnded');
    let combatState = result.state;
    const priorTurnEvents = beforeCombat?.turnNarrationEvents ?? [];
    const priorTurnEventIds = beforeCombat?.turnNarrationEventIds ?? [];
    const hiddenEntityIds = new Set(
      combatState.entities
        .filter((entity) => entity.hidden)
        .map((entity) => entity.id),
    );
    const currentTurnEventIds = result.events.flatMap((event, index) => {
      const referencesHiddenEntity = Object.entries(
        event as Record<string, unknown>,
      ).some(([key, value]) => {
        if (!/(?:entity|mover|attacker|reactor).*ids?$/i.test(key))
          return false;
        const ids = Array.isArray(value) ? value : [value];
        return ids.some(
          (id) => typeof id === 'string' && hiddenEntityIds.has(id),
        );
      });
      return referencesHiddenEntity ? [] : [String(this.seq + index + 1)];
    });
    const turnNarrationEvents = [
      ...priorTurnEvents,
      ...result.events.map((event) => ({ ...event })),
    ];
    const turnNarrationEventIds = [
      ...priorTurnEventIds,
      ...currentTurnEventIds,
    ];
    if (beforeCombat)
      combatState = {
        ...combatState,
        turnNarrationEvents,
        turnNarrationEventIds,
      };
    const lifecycleEvents: Record<string, unknown>[] = [];
    if (beforeCombat && resolved && !combatState.pendingReaction) {
      const turnId = beforeCombat.turnId ?? randomUUID();
      combatState = {
        ...combatState,
        phase: 'narrating',
        turnId,
        narrationAttempts: 0,
      };
      lifecycleEvents.push({
        type: 'TurnResolved',
        turnId,
        entityId: beforeCombat.combat.activeEntityId ?? 'unknown',
        eventIds: turnNarrationEventIds,
      });
    }
    const committedEvents = [...result.events, ...lifecycleEvents];
    const gameState = settleEngine(
      {
        ...(this.state.gameState as Record<string, unknown> | undefined),
        combatRoom: combatState,
      },
      result.slots,
    );
    const writes = committedEvents.map((event) => ({
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
    // TurnResolved.eventIds were derived from `this.seq + index + 1` before the
    // write; they are only correct if the store assigned contiguous seqs.
    const firstSeq = this.seq + 1;
    const contiguous = stored.events.every(
      (event, index) => event.seq === firstSeq + index,
    );
    this.seq = stored.events.at(-1)?.seq ?? this.seq;
    // Never throw after the durable write: memory must follow the store or a
    // retry would accept the turn again from stale state.
    this.state = { ...this.state, gameState } as RoomState;
    if (actionId) this.actionIds.add(actionId);
    if (!contiguous)
      console.error(
        `Combat turn events were stored with non-contiguous seq for ${this.sessionId}`,
      );
    this.announceCombat(combatState, committedEvents, accountId);
  }

  /** Broadcast what changed, arm the reaction deadline and queue the DM's narration. */
  private announceCombat(
    state: NonNullable<ReturnType<typeof roomGameState>>,
    events: readonly Record<string, unknown>[],
    accountId: string | undefined,
  ): void {
    // TurnResolved is log/DM-input only (ADR-034 §5): its filtered eventIds
    // still disclose hidden-event count through sequence gaps.
    const clientEvents = events.filter(
      (event) => event.type !== 'TurnResolved',
    );
    if (clientEvents.length)
      this.broadcast({
        seq: this.seq,
        type: 'CombatEvents',
        payload: { events: clientEvents.map(toWireEvent) },
      } as ServerMessage);
    const ended = events.find((event) => event.type === 'CombatEnded');
    const roundBoundary = events.some(
      (event) =>
        event.type === 'TurnStarted' &&
        Number(event.round) > this.combatRoundForLateJoin,
    );
    this.combatRoundForLateJoin = state.combat.round;
    if (ended || roundBoundary)
      void this.enqueue(async () => {
        await this.admitApprovedLateJoins();
        this.broadcast({
          seq: this.seq,
          type: 'StateSync',
          payload: this.clientSyncPayload(),
        });
      }).catch(() => undefined);
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
    if (
      events.some(
        (event) =>
          event.type === 'TurnStarted' || event.type === 'CombatStarted',
      )
    )
      this.queueAwayAutopilot();
    const resolvedEvent = events.find((event) => event.type === 'TurnResolved');
    const narrate = resolvedEvent !== undefined;
    const combatTurnId = resolvedEvent?.turnId as string | undefined;
    if (narrate && (this.turnRunner || combatTurnId))
      this.queueNarration(
        [...(state.turnNarrationEvents ?? []), resolvedEvent],
        accountId,
        combatTurnId,
      );
  }

  private queueAwayAutopilot(): void {
    void this.enqueue(async () => {
      if (this.state.paused || this.turnInFlight) return;
      const current = roomGameState(this.state);
      const game = this.state.gameState as
        | { combatActors?: Record<string, string> }
        | undefined;
      const activeId = current?.combat.activeEntityId;
      if (!current || !activeId) return;
      const partySeatId = seatIdFromEntityId(activeId);
      let seatId = partySeatId;
      if (partySeatId !== undefined) {
        const presence = this.reactionSeatPresence(activeId);
        if (presence !== 'away' && presence !== 'revoked') return;
      } else {
        if (!game?.combatActors) return;
        const accountId = Object.entries(game.combatActors).find(
          ([, actorId]) => actorId === activeId,
        )?.[0];
        const seat = this.state.seats.find(
          (item) => item.accountId === accountId,
        );
        if (!seat || seat.presence !== 'away') return;
        seatId = seat.seatId;
      }
      const dodge = this.combatRuntime.execute(
        current,
        activeId,
        { command: 'dodge' },
        { now: Date.now() },
      );
      const action = 'code' in dodge ? 'hold' : 'dodge';
      const prepared = 'code' in dodge ? current : dodge.state;
      const finish = this.combatRuntime.execute(
        prepared,
        activeId,
        { command: 'end-turn' },
        { now: Date.now() },
      );
      if ('code' in finish) return;
      await this.commitCombat(
        randomUUID(),
        {
          state: finish.state,
          events: [
            ...('code' in dodge ? [] : dodge.events),
            ...finish.events,
            {
              type: 'AutopilotActed',
              seatId,
              action,
              reason: 'away-at-turn-start',
              consumable: 'none',
            },
          ],
        },
        undefined,
      );
    }).catch(() => undefined);
  }

  /** The DM narrates what the engine already decided; it never decides outcomes. */
  private queueNarration(
    events: readonly Record<string, unknown>[],
    accountId: string | undefined,
    combatTurnId?: string,
  ): void {
    const owner =
      accountId ??
      this.state.seats.find((seat) => seat.accountId)?.accountId ??
      undefined;
    if (!owner) {
      if (combatTurnId)
        void this.enqueue(() => this.commitCombatFallback(combatTurnId)).catch(
          () => undefined,
        );
      return;
    }
    const combat = roomGameState(this.state);
    const hiddenEntityIds = new Set(
      (combat?.entities ?? [])
        .filter((entity) => entity.hidden)
        .map((entity) => entity.id),
    );
    const facts = events
      .filter((event) => {
        const referencesHiddenEntity = Object.entries(event).some(
          ([key, value]) => {
            if (!/(?:entity|mover|attacker|reactor).*ids?$/i.test(key))
              return false;
            const ids = Array.isArray(value) ? value : [value];
            return ids.some(
              (id) => typeof id === 'string' && hiddenEntityIds.has(id),
            );
          },
        );
        return (
          !referencesHiddenEntity &&
          [
            'HpChanged',
            'EntityMoved',
            'CombatEnded',
            'ReactionResolved',
          ].includes(String(event.type))
        );
      })
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
      ...(combatTurnId ? { combatTurnId } : {}),
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
    if (
      this.reactionSeatPresence(prompt.entityId) &&
      ['away', 'revoked', 'unknown'].includes(
        this.reactionSeatPresence(prompt.entityId)!,
      )
    ) {
      void this.enqueue(() => this.declineExpiredReaction()).catch(
        () => undefined,
      );
      return;
    }
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
    const presence = this.reactionSeatPresence(
      current.pendingReaction.entityId,
    );
    if (presence && ['away', 'revoked', 'unknown'].includes(presence)) {
      const declined = this.combatRuntime.execute(
        current,
        current.pendingReaction.entityId,
        {
          command: 'reaction',
          reactionId: current.pendingReaction.reactionId,
          choice: 'decline',
        },
        { now: Date.now() },
      );
      if (!('code' in declined))
        return this.commitCombat(randomUUID(), declined, undefined);
    }
    const result = this.combatRuntime.expire(current, Date.now());
    if (!result) return this.scheduleReaction();
    await this.commitCombat(randomUUID(), result, undefined);
  }

  private reactionSeatPresence(
    entityId: string,
  ): RoomState['seats'][number]['presence'] | undefined {
    const partySeatId = seatIdFromEntityId(entityId);
    if (partySeatId !== undefined)
      // A released/revoked seat keeps its entity but loses control: decline at once.
      return (
        this.state.seats.find(
          (seat) => seat.seatId === partySeatId && this.isPlayableSeat(seat),
        )?.presence ?? 'revoked'
      );
    const game = this.state.gameState as
      | { combatActors?: Record<string, string> }
      | undefined;
    const accountId = Object.entries(game?.combatActors ?? {}).find(
      ([, actor]) => actor === entityId,
    )?.[0];
    return this.state.seats.find((seat) => seat.accountId === accountId)
      ?.presence;
  }

  /** The retained PC entity is now uncontrolled: decline its reaction and defend on its turn (ADR-035 §2). */
  private afterSeatReleased(): void {
    this.scheduleReaction();
    this.queueAwayAutopilot();
  }

  /** ADR-035: once bindings are enforced an unbound seat has no gameplay control. */
  /** Current seat for an account; in party mode it must also hold a live binding. */
  private requireBoundSeat(accountId: string): Seat {
    const seat = this.state.seats.find((item) => item.accountId === accountId);
    if (!seat) throw new Error('Account is not seated');
    this.assertSeatBound(seat);
    return seat;
  }

  private hasCurrentBinding(seat: Seat): boolean {
    return this.seatBindings.get(seat.seatId)?.accountId === seat.accountId;
  }

  private isPendingLateJoinSeat(seat: Seat): boolean {
    return (this.state.lateJoinRequests ?? []).some(
      (request) => request.approved && request.accountId === seat.accountId,
    );
  }

  private isPlayableSeat(seat: Seat): boolean {
    return this.hasCurrentBinding(seat) && !this.isPendingLateJoinSeat(seat);
  }

  private assertSeatBound(seat: Seat): void {
    if (this.bindingEnforced && !this.isPlayableSeat(seat))
      throw new RoomSeatRequiredError();
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
    if (message.type === 'StateSync') {
      for (const [accountId, connection] of this.connections)
        connection.send({
          ...message,
          payload: {
            ...this.clientSyncPayload(),
            state: this.clientState(accountId),
          },
        });
      return;
    }
    for (const connection of this.connections.values())
      connection.send(message);
  }

  private async deliverSpotlightPrompt(): Promise<void> {
    const eligible = this.state.seats.filter(
      (seat) =>
        (seat.presence === 'connected' || seat.presence === 'returning') &&
        this.connections.has(seat.accountId) &&
        (this.state.spotlightTurn ?? 0) -
          (this.state.spotlightActivity?.[seat.accountId] ??
            this.state.spotlightTurn ??
            0) <=
          10,
    );
    if (eligible.length === 0) return;
    const cursor = this.state.spotlightCursor ?? 0;
    const target = eligible[cursor % eligible.length]!;
    const turn = (this.state.spotlightTurn ?? 0) + 1;
    const event = await this.persist('SpotlightPrompted', {
      turn,
      cursor: cursor + 1,
    });
    this.connections.get(target.accountId)?.send({
      seq: event.seq,
      type: 'SpotlightPrompt',
      payload: {
        turn,
        prompt: target.displayName + ', what does your character do next?',
      },
    } as ServerMessage);
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
    clearTimeout(this.restVoteTimer);
    for (const timer of this.lateJoinExpiryTimers.values()) clearTimeout(timer);
    this.lateJoinExpiryTimers.clear();
    for (const timer of this.presenceTimers.values()) clearTimeout(timer);
    this.presenceTimers.clear();
    for (const timer of this.presenceEventTimers.values()) clearTimeout(timer);
    this.presenceEventTimers.clear();
    this.pendingPresenceEvents.clear();
    for (const claim of this.seatClaims.values()) {
      clearTimeout(claim.timer);
      claim.decide(false);
    }
    this.seatClaims.clear();
    this.disconnectedAt.clear();
    this.disconnectedMs.clear();
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
