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

const SCRIPTED = {
  seatId: SeatIdSchema.parse('00000000-0000-4000-8000-0000000000b1'),
  accountId: AccountIdSchema.parse('00000000-0000-4000-8000-0000000000a1'),
  displayName: 'Scripted Sam',
} as const;

/** Trivial single-room actor: join, presence, StateSync, one scripted participant. */
export class Room {
  private seq = 0;
  private seats = new Map<string, Seat>();
  private conns = new Map<string, Set<Send>>();
  private timer: NodeJS.Timeout | undefined;
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
    };
  }

  /** Seats the account (max 6), sends StateSync to it, broadcasts presence. Returns leave(). */
  join(account: Account, send: Send): (() => void) | null {
    let seat = this.seats.get(account.id);
    if (!seat) {
      if (this.seats.size >= 6) return null;
      seat = {
        seatId: SeatIdSchema.parse(crypto.randomUUID()),
        accountId: account.id,
        displayName: account.displayName,
        presence: 'offline',
      };
      this.seats.set(account.id, seat);
    }
    const set = this.conns.get(account.id) ?? new Set<Send>();
    set.add(send);
    this.conns.set(account.id, set);
    this.setPresence(seat, 'online');
    send({
      seq: ++this.seq,
      type: 'StateSync',
      payload: { state: this.state() },
    });
    return () => {
      set.delete(send);
      if (set.size === 0) this.setPresence(seat, 'offline');
    };
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
