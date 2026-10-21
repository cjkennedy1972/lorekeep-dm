const BURST_CAPACITY = 5;
const BURST_REFILL_MS = 2_000;
const SUSTAINED_WINDOW_MS = 10 * 60_000;
const SUSTAINED_LIMIT = 40;
const DUPLICATE_WINDOW_MS = 60_000;
const NON_ALLOW_WINDOW_MS = 5 * 60_000;
const NON_ALLOW_LIMIT = 3;
const AUTO_MUTE_MS = 5 * 60_000;
const TABLE_WINDOW_MS = 60_000;
const TABLE_GATE_LIMIT = 40;
const IDLE_EVICTION_MS = 60 * 60_000;
const SWEEP_INTERVAL_MS = 60_000;

type SeatBucket = {
  tokens: number;
  updatedAt: number;
  submissions: number[];
  lastText?: { text: string; at: number };
  nonAllows: number[];
  mutedUntil: number;
  lastAccessAt: number;
};

type TableGate = { calls: number[]; lastAccessAt: number };

/** In-process per-table chat admission policy; callers enforce socket queue bounds separately. */
export class ChatPolicy {
  private readonly seats = new Map<string, SeatBucket>();
  private readonly tableGates = new Map<string, TableGate>();
  private lastSweepAt = Number.NEGATIVE_INFINITY;

  private sweepOnAccess(now: number): void {
    if (now - this.lastSweepAt >= SWEEP_INTERVAL_MS) this.sweep(now);
  }

  /** Evicts inactive per-seat and per-table counters; may also be called by a periodic sweep. */
  sweep(now = Date.now()): number {
    this.lastSweepAt = now;
    let removed = 0;
    for (const [key, bucket] of this.seats) {
      if (bucket.lastAccessAt <= now - IDLE_EVICTION_MS) {
        this.seats.delete(key);
        removed++;
      }
    }
    for (const [key, gate] of this.tableGates) {
      if (gate.lastAccessAt <= now - IDLE_EVICTION_MS) {
        this.tableGates.delete(key);
        removed++;
      }
    }
    return removed;
  }

  private seat(roomId: string, seatId: string, now: number): SeatBucket {
    this.sweepOnAccess(now);
    const key = `${roomId}:${seatId}`;
    let bucket = this.seats.get(key);
    if (!bucket) {
      bucket = {
        tokens: BURST_CAPACITY,
        updatedAt: now,
        submissions: [],
        nonAllows: [],
        mutedUntil: 0,
        lastAccessAt: now,
      };
      this.seats.set(key, bucket);
    }
    bucket.lastAccessAt = now;
    return bucket;
  }

  /** Reserves one chat-bucket submission; duplicate attempts consume a token too. */
  reserve(
    roomId: string,
    seatId: string,
    normalizedText: string,
    now = Date.now(),
  ): 'allow' | 'burst' | 'sustained' | 'duplicate' | 'muted' {
    const bucket = this.seat(roomId, seatId, now);
    if (bucket.mutedUntil > now) return 'muted';
    bucket.tokens = Math.min(
      BURST_CAPACITY,
      bucket.tokens + Math.max(0, now - bucket.updatedAt) / BURST_REFILL_MS,
    );
    bucket.updatedAt = now;
    if (bucket.tokens < 1) return 'burst';
    bucket.tokens -= 1;

    bucket.submissions = bucket.submissions.filter(
      (at) => at > now - SUSTAINED_WINDOW_MS,
    );
    bucket.submissions.push(now);
    if (bucket.submissions.length > SUSTAINED_LIMIT) return 'sustained';
    if (
      bucket.lastText?.text === normalizedText &&
      now - bucket.lastText.at < DUPLICATE_WINDOW_MS
    )
      return 'duplicate';
    bucket.lastText = { text: normalizedText, at: now };
    return 'allow';
  }

  reserveTableGate(roomId: string, now = Date.now()): boolean {
    this.sweepOnAccess(now);
    const gate = this.tableGates.get(roomId) ?? {
      calls: [],
      lastAccessAt: now,
    };
    const calls = gate.calls.filter((at) => at > now - TABLE_WINDOW_MS);
    gate.lastAccessAt = now;
    if (calls.length >= TABLE_GATE_LIMIT) {
      gate.calls = calls;
      this.tableGates.set(roomId, gate);
      return false;
    }
    calls.push(now);
    gate.calls = calls;
    this.tableGates.set(roomId, gate);
    return true;
  }

  recordNonAllow(
    roomId: string,
    seatId: string,
    now = Date.now(),
    attributable = true,
  ): boolean {
    if (!attributable) return false;
    const bucket = this.seat(roomId, seatId, now);
    bucket.nonAllows = bucket.nonAllows.filter(
      (at) => at > now - NON_ALLOW_WINDOW_MS,
    );
    bucket.nonAllows.push(now);
    if (bucket.nonAllows.length < NON_ALLOW_LIMIT) return false;
    bucket.mutedUntil = now + AUTO_MUTE_MS;
    bucket.nonAllows = [];
    return true;
  }

  isMuted(roomId: string, seatId: string, now = Date.now()): boolean {
    return this.seat(roomId, seatId, now).mutedUntil > now;
  }

  liftMute(roomId: string, seatId: string): void {
    const bucket = this.seats.get(`${roomId}:${seatId}`);
    if (bucket) {
      // This cache is cleared on lift; the chat_mutes database row remains authoritative.
      bucket.mutedUntil = 0;
      bucket.nonAllows = [];
    }
  }
}
