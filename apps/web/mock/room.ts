import { randomUUID } from 'node:crypto';
import { characterById } from './characters.js';
import {
  AccountIdSchema,
  ClientRoomStateSchema,
  SeatIdSchema,
  SessionIdSchema,
  type Account,
  type Presence,
  type RoomState,
  type Seat,
  type ServerMessage,
} from '@game/schema';

type Send = (msg: ServerMessage) => void;
type RoundId = NonNullable<RoomState['round']>['roundId'];
type RoundCloseReason = NonNullable<
  NonNullable<RoomState['round']>['closeReason']
>;

/** Test-only round driver, reached through POST /api/test/tables/:id/round. */
export type RoundScript =
  | { op: 'open'; deadlineInMs: number | null }
  | { op: 'submit'; accountId: string; text: string }
  | { op: 'queue'; accountId: string; text: string }
  | { op: 'close'; reason: RoundCloseReason }
  | { op: 'resolve' };

type Submission = {
  seatId: Seat['seatId'];
  accountId: Seat['accountId'];
  actionId: string;
  originalActionId: string;
  actionIds: string[];
  text: string;
  playerName: string;
  receiptSeq: number;
  submittedAt?: number;
  editedAt?: number;
};

const SCRIPTED = {
  seatId: SeatIdSchema.parse('00000000-0000-4000-8000-0000000000b1'),
  accountId: AccountIdSchema.parse('00000000-0000-4000-8000-0000000000a1'),
  displayName: 'Scripted Sam',
  matureOptOut: false,
} as const;

/** Trivial single-table actor: join, presence, StateSync, one scripted participant. */
export class Room {
  private seq = 0;
  private seats = new Map<string, Seat>();
  /** Accounts whose seat was created by reserveSeat; their first join announces it, as a fresh seat would. */
  private reserved = new Set<string>();
  private conns = new Map<string, Set<Send>>();
  private timer: NodeJS.Timeout | undefined;
  private paused = false;
  private roundId = randomUUID() as RoundId;
  private submissions = new Map<string, Submission>();
  private roundDurationMs: number | null | undefined;
  private roundStatus: 'open' | 'closing' | 'resolving' | 'resolved' = 'open';
  private closeReason: RoundCloseReason | undefined;
  private deadlineAt: number | null = null;
  private queued = new Map<string, Submission>();
  /** seatId -> bound characterId, the table-side binding the server keeps per seat. */
  private bound = new Map<string, string>();
  private chatSeq = 0;
  readonly sessionId = SessionIdSchema.parse(
    '00000000-0000-4000-8000-0000000000c1',
  );

  /** @param scriptedFlipMs presence toggle interval for the scripted seat; 0 disables. */
  constructor(scriptedFlipMs = 15_000) {
    this.seats.set(SCRIPTED.accountId, { ...SCRIPTED, presence: 'connected' });
    if (scriptedFlipMs > 0) {
      this.timer = setInterval(() => {
        const s = this.seats.get(SCRIPTED.accountId)!;
        this.setPresence(s, s.presence === 'connected' ? 'away' : 'connected');
      }, scriptedFlipMs);
      this.timer.unref();
    }
  }

  state(): RoomState {
    return {
      sessionId: this.sessionId,
      phase: 'lobby',
      seats: [...this.seats.values()],
      paused: this.paused,
      roundsEnabled: true,
      roundDurationMs: this.roundDurationMs,
      round: {
        roundId: this.roundId,
        status: this.roundStatus,
        ...(this.closeReason ? { closeReason: this.closeReason } : {}),
        eligibleSeatIds: [...this.seats.values()].map((s) => s.seatId),
        deadlineAt: this.deadlineAt,
        submissions: [...this.submissions.values()],
        queuedSubmissions: [...this.queued.values()],
      } satisfies NonNullable<RoomState['round']>,
    };
  }

  /** StateSync payload: the round rides beside the state, as the server sends it (clientSyncPayload). */
  syncPayload(viewerAccountId: string) {
    const { round, ...rawState } = this.state();
    const state = ClientRoomStateSchema.parse({
      ...rawState,
      seats: rawState.seats.map((seat) => {
        const { accountId, ...clientSeat } = seat;
        const isSelf = accountId === viewerAccountId;
        return isSelf
          ? { ...clientSeat, accountId, isSelf }
          : { ...clientSeat, isSelf };
      }),
    });
    const boundSeatIds = [...this.bound.keys()].map((id) =>
      SeatIdSchema.parse(id),
    );
    return {
      state,
      round: round && this.publicRound(round),
      // Omitted when empty, as the server sends it: clients treat absent as no bound seats.
      ...(boundSeatIds.length ? { boundSeatIds } : {}),
    };
  }

  /** Strips submission text and accountId, which the strict RoundSnapshot schema rejects. */
  private publicRound(round: NonNullable<RoomState['round']>) {
    const pub = (s: Submission) => ({
      seatId: s.seatId,
      actionId: s.actionId,
      originalActionId: s.originalActionId,
      actionIds: s.actionIds,
      playerName: s.playerName,
      receiptSeq: s.receiptSeq,
      ...(s.submittedAt === undefined ? {} : { submittedAt: s.submittedAt }),
      ...(s.editedAt === undefined ? {} : { editedAt: s.editedAt }),
    });
    return {
      ...round,
      submissions: round.submissions.map(pub),
      queuedSubmissions: round.queuedSubmissions.map(pub),
    };
  }

  /** Applies a round or host message from a seat; the seat identity always comes from the socket. */
  act(accountId: string, actionId: string, type: string, payload: unknown) {
    const seat = this.seats.get(accountId);
    if (!seat) return;
    const body = (payload ?? {}) as Record<string, unknown>;
    if (type === 'BindCharacter')
      return this.bindCharacter(seat, actionId, body);
    const mine = this.submissions.get(accountId) ?? this.queued.get(accountId);
    if (type === 'PlayerAction' && typeof body.text === 'string') {
      // Like the server, a seat acting while the round is closing lands in the queue.
      (this.roundStatus === 'open' ? this.submissions : this.queued).set(
        accountId,
        this.submission(seat, actionId, body.text),
      );
    } else if (
      type === 'EditAction' &&
      mine &&
      mine.actionId === body.editedActionId &&
      typeof body.text === 'string'
    ) {
      mine.text = body.text;
      mine.editedAt = Date.now();
    } else if (
      type === 'WithdrawAction' &&
      mine &&
      mine.actionId === body.withdrawnActionId
    ) {
      this.submissions.delete(accountId);
      this.queued.delete(accountId);
    } else if (type === 'ConfigureRoundTimer' && 'durationMs' in body) {
      this.roundDurationMs = body.durationMs as number | null;
    } else if (type === 'ResolveNow') {
      this.submissions.clear();
      this.queued.clear();
      this.roundId = randomUUID() as RoundId;
      this.roundStatus = 'open';
      this.closeReason = undefined;
      this.deadlineAt = null;
    } else if (type === 'ChatSend' && typeof body.text === 'string') {
      this.chat(seat, body.text);
      return;
    } else return;
    this.broadcastState();
    this.sendSeatPrivateRoundSync(accountId);
  }

  /** Mirrors the server's BindCharacter rejections: each sends one typed Error with the request actionId echoed. */
  private bindCharacter(
    seat: Seat,
    actionId: string,
    body: Record<string, unknown>,
  ) {
    const character =
      typeof body.characterId === 'string'
        ? characterById(body.characterId)
        : undefined;
    const reject = (code: string, message: string) => {
      const error = {
        seq: this.seq,
        type: 'Error',
        payload: { code, message, actionId },
      } as ServerMessage;
      for (const send of this.conns.get(seat.accountId) ?? []) send(error);
    };
    // Foreign and unknown ids get the same neutral rejection, so the client never learns whether a character exists.
    if (!character || character.accountId !== seat.accountId)
      return reject('ACTION_REJECTED', "That character can't be bound.");
    if (character.revision !== body.expectedRevision)
      return reject(
        'STALE_REVISION',
        'The character changed. Reload and retry.',
      );
    if (this.bound.has(seat.seatId))
      return reject(
        'ALREADY_BOUND',
        'This seat already has a character bound.',
      );
    // Bound to another seat at this table: the real server answers with the neutral rejection, not ALREADY_BOUND.
    if ([...this.bound.values()].includes(character.id))
      return reject('ACTION_REJECTED', "That character can't be bound.");
    this.bound.set(seat.seatId, character.id);
    this.emit({
      seq: ++this.seq,
      type: 'SeatCharacterBound',
      payload: { seatId: seat.seatId },
    } as ServerMessage);
    for (const send of this.conns.get(seat.accountId) ?? [])
      send({
        seq: ++this.seq,
        type: 'SeatCharacterBoundPrivate',
        payload: { seatId: seat.seatId },
      } as ServerMessage);
  }

  /** Sends one message to every connected seat. */
  private emit(msg: ServerMessage) {
    for (const set of this.conns.values()) for (const send of set) send(msg);
  }

  /**
   * Creates the account's seat without sending anything, so SeatAuthenticated can carry its id before join's frames.
   * Returns null when the table is full.
   */
  reserveSeat(account: Account, isHost = false): string | null {
    const existing = this.seats.get(account.id);
    if (existing) return existing.seatId;
    if (this.seats.size >= 6) return null;
    this.seats.set(account.id, this.newSeat(account, isHost));
    this.reserved.add(account.id);
    return this.seats.get(account.id)!.seatId;
  }

  private newSeat(account: Account, isHost: boolean): Seat {
    return {
      seatId: SeatIdSchema.parse(crypto.randomUUID()),
      accountId: account.id,
      displayName: account.displayName,
      presence: 'offline',
      isHost,
      matureOptOut: false,
    };
  }

  private submission(seat: Seat, actionId: string, text: string): Submission {
    return {
      seatId: seat.seatId,
      accountId: seat.accountId,
      actionId,
      originalActionId: actionId,
      actionIds: [actionId],
      text,
      playerName: seat.displayName,
      receiptSeq: this.seq + 1,
      submittedAt: Date.now(),
    };
  }

  /** Test driver: moves the single table round through open, submit, queue, close, and resolve. */
  script(op: RoundScript) {
    if (op.op === 'open') {
      this.roundId = randomUUID() as RoundId;
      this.roundStatus = 'open';
      this.closeReason = undefined;
      this.deadlineAt =
        op.deadlineInMs === null ? null : Date.now() + op.deadlineInMs;
      this.submissions.clear();
      this.queued.clear();
    } else if (op.op === 'submit' || op.op === 'queue') {
      const seat = this.seats.get(op.accountId);
      if (!seat) throw new Error('No seat for that account at this table.');
      (op.op === 'submit' ? this.submissions : this.queued).set(
        op.accountId,
        this.submission(seat, randomUUID(), op.text),
      );
    } else if (op.op === 'close') {
      this.roundStatus = 'closing';
      this.closeReason = op.reason;
      this.deadlineAt = null;
    } else {
      this.roundStatus = 'resolved';
    }
    this.broadcastState();
  }

  /** Broadcasts an OOC chat line from a seat, the way the server echoes ChatMessage. */
  private chat(seat: Seat, text: string) {
    const msg: ServerMessage = {
      seq: ++this.seq,
      type: 'ChatMessage',
      payload: {
        messageId: randomUUID(),
        roomId: this.sessionId,
        seatId: seat.seatId,
        receiptSeq: ++this.chatSeq,
        receivedAt: Date.now(),
        text,
        channel: 'ooc',
        gateDecision: { verdict: 'allow' },
      },
    } as unknown as ServerMessage;
    for (const set of this.conns.values()) for (const send of set) send(msg);
  }

  private sendSeatPrivateRoundSync(accountId: string) {
    const submission =
      this.submissions.get(accountId) ?? this.queued.get(accountId);
    for (const send of this.conns.get(accountId) ?? [])
      send({
        seq: this.seq,
        type: 'SeatPrivateRoundSync',
        payload: {
          roundId: this.roundId,
          ...(submission
            ? {
                submission: {
                  actionId: submission.actionId,
                  text: submission.text,
                  queued: this.queued.has(accountId),
                  submittedAt: submission.submittedAt,
                },
              }
            : {}),
        },
      } as ServerMessage);
  }

  private broadcastState() {
    const seq = ++this.seq;
    for (const [accountId, set] of this.conns) {
      const msg: ServerMessage = {
        seq,
        type: 'StateSync',
        payload: this.syncPayload(accountId),
      };
      for (const send of set) send(msg);
    }
  }

  /** Seats the account (max 6), sends StateSync to it, broadcasts presence. Returns leave(). */
  join(account: Account, send: Send, isHost = false): (() => void) | null {
    let seat = this.seats.get(account.id);
    let fresh = this.reserved.delete(account.id);
    if (!seat) {
      if (this.seats.size >= 6) return null;
      seat = this.newSeat(account, isHost);
      this.seats.set(account.id, seat);
      fresh = true;
    }
    const set = this.conns.get(account.id) ?? new Set<Send>();
    set.add(send);
    this.conns.set(account.id, set);
    this.setPresence(seat, 'connected');
    // The protocol has no seat-added message: a new seat is announced by re-syncing everyone.
    if (fresh) this.broadcastState();
    else
      send({
        seq: ++this.seq,
        type: 'StateSync',
        payload: this.syncPayload(account.id),
      });
    this.sendSeatPrivateRoundSync(account.id);
    return () => {
      set.delete(send);
      if (set.size === 0) this.setPresence(seat, 'disconnected');
    };
  }

  /** Broadcasts an anonymous X-card signal to every connected seat. */
  xCard() {
    const msg: ServerMessage = {
      seq: ++this.seq,
      type: 'SafetyFlag',
      payload: { kind: 'x-card' },
    };
    for (const set of this.conns.values()) for (const send of set) send(msg);
  }

  /** Pauses the table and broadcasts the updated state to every connected seat. */
  setPaused(paused: boolean) {
    this.paused = paused;
    this.broadcastState();
  }

  /** Removes a deleted account's seat. */
  remove(accountId: string) {
    const seat = this.seats.get(accountId);
    if (seat && this.bound.delete(seat.seatId))
      this.emit({
        seq: ++this.seq,
        type: 'SeatCharacterReleased',
        payload: { seatId: seat.seatId },
      } as ServerMessage);
    this.seats.delete(accountId);
    this.conns.delete(accountId);
  }

  close() {
    clearInterval(this.timer);
  }

  private setPresence(seat: Seat, presence: Presence) {
    seat.presence = presence;
    const msg: ServerMessage = {
      seq: ++this.seq,
      type: 'PresenceChanged',
      payload: { seatId: seat.seatId, presence },
    };
    for (const set of this.conns.values()) for (const s of set) s(msg);
  }
}
