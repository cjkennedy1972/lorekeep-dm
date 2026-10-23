import { describe, expect, it } from 'vitest';
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
