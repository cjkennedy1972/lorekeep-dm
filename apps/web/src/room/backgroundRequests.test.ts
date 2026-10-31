import { describe, expect, test } from 'vitest';
import {
  createInFlightGate,
  isBackgroundRefusal,
} from './backgroundRequests.js';

describe('createInFlightGate', () => {
  test('admits one request until the reply ends it', () => {
    const gate = createInFlightGate(5_000, () => 0);
    expect(gate.begin()).toBe(true);
    expect(gate.begin()).toBe(false);
    gate.end();
    expect(gate.begin()).toBe(true);
  });

  test('reopens after the ttl so a lost reply cannot block forever', () => {
    let now = 1_000;
    const gate = createInFlightGate(5_000, () => now);
    expect(gate.begin()).toBe(true);
    now = 5_999;
    expect(gate.begin()).toBe(false);
    now = 6_000;
    expect(gate.begin()).toBe(true);
  });
});

describe('isBackgroundRefusal', () => {
  test('treats a RATE_LIMITED reply with no actionId as a refused background read', () => {
    expect(
      isBackgroundRefusal({
        code: 'RATE_LIMITED',
        message: 'Too many messages.',
      }),
    ).toBe(true);
  });

  test('keeps a RATE_LIMITED reply tied to a player action visible', () => {
    expect(
      isBackgroundRefusal({
        code: 'RATE_LIMITED',
        message: 'Too many requests. Try again later.',
        actionId: 'a1',
      }),
    ).toBe(false);
  });

  test('keeps other error codes visible', () => {
    expect(
      isBackgroundRefusal({ code: 'COMMAND_REJECTED', message: 'No.' }),
    ).toBe(false);
  });
});
