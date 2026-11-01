import { describe, expect, it } from 'vitest';
import {
  BoundedCounter,
  BusyError,
  Limiter,
  ProgressiveThrottle,
} from '../../src/accounts/throttle.js';

describe('BoundedCounter', () => {
  it('counts within the window and expires after it', () => {
    const c = new BoundedCounter(1000, 100);
    expect(c.hit('a', 0)).toBe(1);
    expect(c.hit('a', 10)).toBe(2);
    expect(c.count('a', 999)).toBe(2);
    expect(c.count('a', 1000)).toBe(0);
  });
  it('caps size, evicting expired then oldest keys', () => {
    const c = new BoundedCounter(1000, 3);
    c.hit('a', 0);
    c.hit('b', 1);
    c.hit('c', 2);
    c.hit('d', 3);
    expect(c.size).toBe(3);
    expect(c.count('a', 3)).toBe(0);
    c.hit('e', 5000);
    expect(c.size).toBe(1);
  });
});

describe('ProgressiveThrottle', () => {
  it('escalates exhausted windows, caps the delay, and resets after quiet time or success', () => {
    const throttle = new ProgressiveThrottle(2, 100, [60, 120, 300], 1_000, 10);
    expect(throttle.hit('a', 0)).toBe(0);
    expect(throttle.hit('a', 1)).toBe(60);
    expect(throttle.remainingMs('a', 30)).toBe(31);
    expect(throttle.hit('a', 61)).toBe(0);
    expect(throttle.hit('a', 62)).toBe(120);
    expect(throttle.hit('a', 183)).toBe(0);
    expect(throttle.hit('a', 184)).toBe(300);
    expect(throttle.hit('a', 485)).toBe(0);
    expect(throttle.hit('a', 486)).toBe(300);
    expect(throttle.hit('a', 2_000)).toBe(0);
    expect(throttle.hit('a', 2_001)).toBe(60);
    throttle.clear('a');
    expect(throttle.remainingMs('a', 2_002)).toBe(0);
  });
});

describe('Limiter', () => {
  it('runs at most max tasks at once and rejects waiters after the timeout', async () => {
    const limiter = new Limiter(2, 50);
    let running = 0;
    let peak = 0;
    const release: Array<() => void> = [];
    const task = () =>
      limiter.run(async () => {
        peak = Math.max(peak, ++running);
        await new Promise<void>((r) => release.push(r));
        running--;
      });
    const a = task();
    const b = task();
    await expect(task()).rejects.toBeInstanceOf(BusyError);
    expect(peak).toBe(2);
    release.forEach((r) => r());
    await Promise.all([a, b]);
    await expect(limiter.run(async () => 'ok')).resolves.toBe('ok');
  });
  it('hands a freed slot to a queued waiter', async () => {
    const limiter = new Limiter(1, 1000);
    let free!: () => void;
    const first = limiter.run(() => new Promise<void>((r) => (free = r)));
    const second = limiter.run(async () => 'second');
    free();
    await first;
    await expect(second).resolves.toBe('second');
  });
});
