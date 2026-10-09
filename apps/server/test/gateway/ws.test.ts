import { describe, expect, it } from 'vitest';
import { ClientEnvelopeSchema } from '@game/schema';
import { consumeMessageToken } from '../../src/gateway/ws.js';
describe('gateway envelope', () => {
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
