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
