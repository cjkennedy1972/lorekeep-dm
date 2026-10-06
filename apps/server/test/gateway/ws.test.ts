import { describe, expect, it } from 'vitest';
import { ClientEnvelopeSchema } from '@game/schema';
describe('gateway envelope', () => {
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
