import { randomUUID } from 'node:crypto';
import {
  AccountIdSchema,
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

type Submission = {
  seatId: Seat['seatId'];
  accountId: Seat['accountId'];
  actionId: string;
  originalActionId: string;
  actionIds: string[];
  text: string;
  playerName: string;
  receiptSeq: number;
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
  private conns = new Map<string, Set<Send>>();
  private timer: NodeJS.Timeout | undefined;
  private paused = false;
  private roundId = randomUUID() as RoundId;
  private submissions = new Map<string, Submission>();
  private roundDurationMs: number | null | undefined;
  readonly sessionId = SessionIdSchema.parse(
    '00000000-0000-4000-8000-0000000000c1',
  );

  /** @param scriptedFlipMs presence toggle interval for the scripted seat; 0 disables. */
  constructor(scriptedFlipMs = 15_000) {
    this.seats.set(SCRIPTED.accountId, { ...SCRIPTED, presence: 'online' });
    if (scriptedFlipMs > 0) {
      this.timer = setInterval(() => {
        const s = this.seats.get(SCRIPTED.accountId)!;
        this.setPresence(s, s.presence === 'online' ? 'away' : 'online');
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
        status: 'open',
        eligibleSeatIds: [...this.seats.values()].map((s) => s.seatId),
        deadlineAt: null,
        submissions: [...this.submissions.values()],
        queuedSubmissions: [],
      } satisfies NonNullable<RoomState['round']>,
    };
  }

  /** Applies a round or host message from a seat; the seat identity always comes from the socket. */
  act(accountId: string, actionId: string, type: string, payload: unknown) {
    const seat = this.seats.get(accountId);
    if (!seat) return;
    const body = (payload ?? {}) as Record<string, unknown>;
    const mine = this.submissions.get(accountId);
    if (type === 'PlayerAction' && typeof body.text === 'string') {
      this.submissions.set(accountId, {
        seatId: seat.seatId,
        accountId: seat.accountId,
        actionId,
        originalActionId: actionId,
        actionIds: [actionId],
        text: body.text,
        playerName: seat.displayName,
        receiptSeq: this.seq + 1,
      });
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
    } else if (type === 'ConfigureRoundTimer' && 'durationMs' in body) {
      this.roundDurationMs = body.durationMs as number | null;
    } else if (type === 'ResolveNow') {
      this.submissions.clear();
      this.roundId = randomUUID() as RoundId;
    } else return;
    this.broadcastState();
  }

  private broadcastState() {
    const msg: ServerMessage = {
      seq: ++this.seq,
      type: 'StateSync',
      payload: { state: this.state() },
    };
    for (const set of this.conns.values()) for (const send of set) send(msg);
  }

  /** Seats the account (max 6), sends StateSync to it, broadcasts presence. Returns leave(). */
  join(account: Account, send: Send): (() => void) | null {
    let seat = this.seats.get(account.id);
    const fresh = !seat;
    if (!seat) {
      if (this.seats.size >= 6) return null;
      seat = {
        seatId: SeatIdSchema.parse(crypto.randomUUID()),
        accountId: account.id,
        displayName: account.displayName,
        presence: 'offline',
        matureOptOut: false,
      };
      this.seats.set(account.id, seat);
    }
    const set = this.conns.get(account.id) ?? new Set<Send>();
    set.add(send);
    this.conns.set(account.id, set);
    this.setPresence(seat, 'online');
    const sync: ServerMessage = {
      seq: ++this.seq,
      type: 'StateSync',
      payload: { state: this.state() },
    };
    // The protocol has no seat-added message: a new seat is announced by re-syncing everyone.
    if (fresh) for (const c of this.conns.values()) for (const s of c) s(sync);
    else send(sync);
    return () => {
      set.delete(send);
      if (set.size === 0) this.setPresence(seat, 'offline');
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
    const msg: ServerMessage = {
      seq: ++this.seq,
      type: 'StateSync',
      payload: { state: this.state() },
    };
    for (const set of this.conns.values()) for (const send of set) send(msg);
  }

  /** Removes a deleted account's seat. */
  remove(accountId: string) {
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
