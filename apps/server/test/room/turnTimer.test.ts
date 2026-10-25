import { afterEach, describe, expect, it, vi } from 'vitest';
import { account, bootstrapped, memoryTable } from './combatFixtures.js';
import { joinSeated } from '../helpers/room.js';

afterEach(() => vi.useRealTimers());

const stage = (opts: Parameters<typeof memoryTable>[2] = {}) => {
  const e = bootstrapped();
  return memoryTable(
    { ...e.game, combatActors: { [account]: 'ent_aria' }, combatRoom: e.state },
    undefined,
    { host: account, ...opts },
  );
};

describe('host turn timer setting (ADR-033 §5.1)', () => {
  it('persists, and a restarted Room replays it', async () => {
    const table = stage();
    const room = table.boot();
    await joinSeated(room, account, table.connection);
    await room.configureTurnTimer(account, 45_000, 'hold');
    expect(room.state.turnTimerMs).toBe(45_000);
    expect(table.events.map((e) => e.type)).toContain('TurnTimerConfigured');
    const again = table.boot();
    expect(again.state.turnTimerMs).toBe(45_000);
    expect(again.state.turnTimeoutAction).toBe('hold');
    await again.configureTurnTimer(account, null);
    expect(table.boot().state.turnTimerMs).toBeNull();
    // Omitting the action leaves the earlier choice in place.
    expect(table.boot().state.turnTimeoutAction).toBe('hold');
  });

  it.each([29_999, 600_001, 45_000.5])('rejects %s ms', async (ms) => {
    const table = stage();
    const room = table.boot();
    await joinSeated(room, account, table.connection);
    await expect(room.configureTurnTimer(account, ms)).rejects.toThrow(
      /between 30 and 600/,
    );
    expect(room.state.turnTimerMs).toBeUndefined();
  });

  it('is host-only', async () => {
    const table = stage({ host: crypto.randomUUID() });
    const room = table.boot();
    await joinSeated(room, account, table.connection);
    await expect(room.configureTurnTimer(account, 60_000)).rejects.toThrow(
      /host/,
    );
  });
});
