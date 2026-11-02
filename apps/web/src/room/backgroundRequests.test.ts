import { describe, expect, test } from 'vitest';
import {
  createInFlightGate,
  isBackgroundRefusal,
  roomErrorAfter,
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

  test('a StateSync burst sends one history request, and a refusal releases the next', () => {
    const gate = createInFlightGate(5_000, () => 0);
    const sent = Array.from({ length: 20 }, () => gate.begin()).filter(Boolean);
    expect(sent).toHaveLength(1);
    // The RATE_LIMITED refusal is a reply, so the gate ends and the next StateSync may ask again.
    gate.end();
    expect(gate.begin()).toBe(true);
  });
});

describe('roomErrorAfter', () => {
  test('absorbs a RATE_LIMITED refusal of a background read and keeps the prior error', () => {
    expect(
      roomErrorAfter(
        {
          type: 'Error',
          payload: { code: 'RATE_LIMITED', message: 'Too many messages.' },
        },
        null,
      ),
    ).toBeNull();
    expect(
      roomErrorAfter(
        {
          type: 'Error',
          payload: { code: 'RATE_LIMITED', message: 'Too many messages.' },
        },
        'The table is offline.',
      ),
    ).toBe('The table is offline.');
  });

  test('shows a RATE_LIMITED reply to a player action', () => {
    expect(
      roomErrorAfter(
        {
          type: 'Error',
          payload: {
            code: 'RATE_LIMITED',
            message: 'Too many requests. Try again later.',
            actionId: 'a1',
          },
        },
        null,
      ),
    ).toBe('Too many requests. Try again later.');
  });

  test('leaves the error unchanged for non-error messages', () => {
    expect(roomErrorAfter({ type: 'StateSync' }, 'x')).toBe('x');
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
