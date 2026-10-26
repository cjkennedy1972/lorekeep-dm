import { describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import {
  ClientEnvelopeSchema,
  KickSeatSchema,
  TransferHostSchema,
  ApproveLateJoinSchema,
  DenyLateJoinSchema,
  EndTableSchema,
  ConfigureRoundTimerSchema,
} from '@game/schema';
import { consumeMessageToken } from '../../src/gateway/ws.js';
import { ConnectionRegistry } from '../../src/gateway/connections.js';
describe('gateway envelope', () => {
  it('accepts the Prism host-control command names and rejects out-of-range timers', () => {
    const base = { actionId: crypto.randomUUID(), lastSeq: 0 };
    const seatId = crypto.randomUUID();
    const requestId = crypto.randomUUID();
    expect(
      KickSeatSchema.safeParse({
        ...base,
        type: 'KickSeat',
        payload: { seatId },
      }).success,
    ).toBe(true);
    expect(
      TransferHostSchema.safeParse({
        ...base,
        type: 'TransferHost',
        payload: { seatId },
      }).success,
    ).toBe(true);
    expect(
      ApproveLateJoinSchema.safeParse({
        ...base,
        type: 'ApproveLateJoin',
        payload: { requestId },
      }).success,
    ).toBe(true);
    expect(
      DenyLateJoinSchema.safeParse({
        ...base,
        type: 'DenyLateJoin',
        payload: { requestId },
      }).success,
    ).toBe(true);
    expect(
      EndTableSchema.safeParse({ ...base, type: 'EndTable', payload: {} })
        .success,
    ).toBe(true);
    for (const durationMs of [null, 30_000, 600_000])
      expect(
        ConfigureRoundTimerSchema.safeParse({
          ...base,
          type: 'ConfigureRoundTimer',
          payload: { durationMs },
        }).success,
      ).toBe(true);
    for (const durationMs of [0, 29_999, 600_001])
      expect(
        ConfigureRoundTimerSchema.safeParse({
          ...base,
          type: 'ConfigureRoundTimer',
          payload: { durationMs },
        }).success,
      ).toBe(false);
  });
  it('enforces a refillable per-socket token bucket', () => {
    const bucket = { tokens: 20, updatedAt: 1000 };
    for (let index = 0; index < 20; index++)
      expect(consumeMessageToken(bucket, 1000)).toBe(true);
    expect(consumeMessageToken(bucket, 1000)).toBe(false);
    expect(consumeMessageToken(bucket, 1100)).toBe(true);
    expect(consumeMessageToken(bucket, 1100)).toBe(false);
  });

  it('replaces an in-memory socket only after the caller validates the seat token', () => {
    const registry = new ConnectionRegistry({
      query: async () => ({ rows: [] }),
    } as never);
    const oldSocket = {
      readyState: 1,
      close: vi.fn(),
    } as unknown as WebSocket;
    const newSocket = {
      readyState: 1,
      close: vi.fn(),
    } as unknown as WebSocket;
    expect(registry.reserveSeat('session:seat', oldSocket)).toEqual({
      reserved: true,
      takenOver: false,
    });
    registry.add(oldSocket, 'auth-hash', 'session:seat');
    expect(registry.reserveSeat('session:seat', newSocket)).toEqual({
      reserved: false,
      takenOver: false,
    });
    expect(oldSocket.close).not.toHaveBeenCalled();
    expect(registry.reserveSeat('session:seat', newSocket, true)).toEqual({
      reserved: true,
      takenOver: true,
    });
    expect(oldSocket.close).toHaveBeenCalledOnce();
    expect(registry.hasSeatSocket('session:seat')).toBe(false);
  });
  it('limits socket authentication attempts per seat, account, and IP', () => {
    const registry = new ConnectionRegistry({
      query: async () => ({ rows: [] }),
    } as never);
    for (let i = 0; i < 5; i++)
      expect(registry.consumeSeatAuthAttempt('session:seat', 10_000 + i)).toBe(
        true,
      );
    expect(registry.consumeSeatAuthAttempt('session:seat', 10_100)).toBe(false);
    expect(registry.consumeSeatAuthAttempt('session:seat', 70_001)).toBe(true);

    for (let i = 0; i < 30; i++)
      expect(
        registry.consumeTransportAuthAttempt(
          `account-${i}`,
          'shared-ip',
          100_000 + i,
        ),
      ).toBe(true);
    for (let i = 0; i < 90; i++)
      expect(
        registry.consumeTransportAuthAttempt(
          `other-${i}`,
          'shared-ip',
          100_200 + i,
        ),
      ).toBe(true);
    expect(
      registry.consumeTransportAuthAttempt(
        'last-account',
        'shared-ip',
        100_400,
      ),
    ).toBe(false);
  });
  it('bounds IP auth history and evicts expired IP keys', () => {
    const registry = new ConnectionRegistry({
      query: async () => ({ rows: [] }),
    } as never);
    for (let i = 0; i < 10_050; i++)
      registry.consumeTransportAuthAttempt(`account-${i}`, `ip-${i}`, 10_000);

    const ipAttempts = (
      registry as unknown as {
        ipAuthAttempts: Map<string, number[]>;
      }
    ).ipAuthAttempts;
    expect(ipAttempts.size).toBeLessThanOrEqual(10_000);
    expect(ipAttempts.has('ip-10049')).toBe(true);

    registry.consumeTransportAuthAttempt('fresh-account', 'fresh-ip', 70_001);
    expect(ipAttempts.size).toBe(1);
    expect(ipAttempts.has('fresh-ip')).toBe(true);
  });
  it('rejects malformed and accepts client wire format', () => {
    expect(ClientEnvelopeSchema.safeParse({ type: 'Resync' }).success).toBe(
      false,
    );
    expect(
      ClientEnvelopeSchema.safeParse({
        actionId: crypto.randomUUID(),
        type: 'Resync',
        payload: {},
        lastSeq: 0,
      }).success,
    ).toBe(true);
  });
});
