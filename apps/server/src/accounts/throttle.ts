/** Fixed-window counters with TTL eviction and a hard size cap (oldest entries dropped first). */
export class BoundedCounter {
  private readonly items = new Map<string, { count: number; reset: number }>();
  constructor(
    private readonly windowMs: number,
    private readonly maxKeys = 10_000,
  ) {}
  private live(key: string, now: number) {
    const item = this.items.get(key);
    if (item && item.reset > now) return item;
    this.items.delete(key);
    return undefined;
  }
  count(key: string, now = Date.now()): number {
    return this.live(key, now)?.count ?? 0;
  }
  remainingMs(key: string, now = Date.now()): number {
    const item = this.live(key, now);
    return item ? Math.max(0, item.reset - now) : 0;
  }
  /** Increments and returns the new count. */
  hit(key: string, now = Date.now()): number {
    const item = this.live(key, now);
    if (item) return ++item.count;
    if (this.items.size >= this.maxKeys) this.evict(now);
    this.items.set(key, { count: 1, reset: now + this.windowMs });
    return 1;
  }
  clear(key: string): void {
    this.items.delete(key);
  }
  get size(): number {
    return this.items.size;
  }
  private evict(now: number): void {
    for (const [key, item] of this.items)
      if (item.reset <= now) this.items.delete(key);
    // Insertion order == oldest first; still full means every key is live.
    for (const key of this.items.keys()) {
      if (this.items.size < this.maxKeys) break;
      this.items.delete(key);
    }
  }
}

/** Escalating retry windows for repeated per-key threshold exhaustion. */
export class ProgressiveThrottle {
  private readonly states = new Map<
    string,
    {
      failures: number;
      windowEndsAt: number;
      level: number;
      blockedUntil: number;
      lastExhaustion: number;
    }
  >();

  constructor(
    private readonly threshold: number,
    private readonly failureWindowMs: number,
    private readonly delaysMs = [60_000, 120_000, 300_000, 600_000, 1_800_000],
    private readonly quietPeriodMs = 3_600_000,
    private readonly maxKeys = 10_000,
  ) {}

  remainingMs(key: string, now = Date.now()): number {
    const state = this.states.get(key);
    return state ? Math.max(0, state.blockedUntil - now) : 0;
  }

  /** Records a failed attempt; returns a delay when the window is exhausted. */
  hit(key: string, now = Date.now()): number {
    let state = this.states.get(key);
    if (!state) {
      if (this.states.size >= this.maxKeys)
        this.states.delete(this.states.keys().next().value as string);
      state = {
        failures: 0,
        windowEndsAt: now + this.failureWindowMs,
        level: -1,
        blockedUntil: 0,
        lastExhaustion: 0,
      };
    }
    if (
      state.lastExhaustion &&
      now - state.lastExhaustion > this.quietPeriodMs
    ) {
      state.level = -1;
      state.failures = 0;
      state.lastExhaustion = 0;
    }
    if (now >= state.windowEndsAt) {
      state.failures = 0;
      state.windowEndsAt = now + this.failureWindowMs;
    }
    state.failures++;
    let delay = 0;
    if (state.failures >= this.threshold) {
      state.level = Math.min(state.level + 1, this.delaysMs.length - 1);
      delay = this.delaysMs[state.level] ?? 0;
      state.failures = 0;
      state.windowEndsAt = now + this.failureWindowMs;
      state.blockedUntil = now + delay;
      state.lastExhaustion = now;
    }
    this.states.delete(key);
    this.states.set(key, state);
    return delay;
  }

  clear(key: string): void {
    this.states.delete(key);
  }
}

export class BusyError extends Error {}

/** Bounds concurrent expensive operations per key without retaining idle keys. */
export class KeyedConcurrencyGate {
  private readonly active = new Map<string, number>();

  constructor(
    private readonly maxPerKey: number,
    private readonly maxKeys = 10_000,
  ) {}

  tryAcquire(key: string): (() => void) | undefined {
    const count = this.active.get(key) ?? 0;
    if (count >= this.maxPerKey) return undefined;
    if (count === 0 && this.active.size >= this.maxKeys) return undefined;
    this.active.set(key, count + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const current = this.active.get(key);
      if (current === undefined || current <= 1) this.active.delete(key);
      else this.active.set(key, current - 1);
    };
  }
}
/** Serializes work by key with a bounded FIFO queue and no idle-key retention. */
export class KeyedSerialQueue {
  private readonly states = new Map<
    string,
    { active: boolean; waiting: Array<(release: () => void) => void> }
  >();

  constructor(
    private readonly maxPendingPerKey = 10,
    private readonly maxKeys = 10_000,
  ) {}

  acquire(key: string): Promise<(() => void) | undefined> {
    let state = this.states.get(key);
    if (!state) {
      if (this.states.size >= this.maxKeys) return Promise.resolve(undefined);
      state = { active: false, waiting: [] };
      this.states.set(key, state);
    }
    if (!state.active) {
      state.active = true;
      return Promise.resolve(this.releaseFor(key, state));
    }
    if (state.waiting.length >= this.maxPendingPerKey)
      return Promise.resolve(undefined);
    return new Promise((resolve) => state!.waiting.push(resolve));
  }

  private releaseFor(
    key: string,
    state: { active: boolean; waiting: Array<(release: () => void) => void> },
  ): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = state.waiting.shift();
      if (next) next(this.releaseFor(key, state));
      else {
        state.active = false;
        this.states.delete(key);
      }
    };
  }
}

/** Limits concurrent expensive work; waiters give up after `waitMs`. */
export class Limiter {
  private active = 0;
  private readonly queue: Array<() => void> = [];
  constructor(
    private readonly max = 4,
    private readonly waitMs = 2000,
  ) {}
  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) {
      await new Promise<void>((resolve, reject) => {
        const grant = () => {
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(() => {
          this.queue.splice(this.queue.indexOf(grant), 1);
          reject(new BusyError('busy'));
        }, this.waitMs);
        this.queue.push(grant);
      });
    } else this.active++;
    try {
      return await work();
    } finally {
      const next = this.queue.shift();
      if (next)
        next(); // slot handed over; active stays the same
      else this.active--;
    }
  }
}
