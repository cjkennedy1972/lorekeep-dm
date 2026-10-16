import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { LlmAdapter } from '../../src/llm/adapter.js';
import { ProductionSoloTurnRunner } from '../../src/room/productionTurnRunner.js';

function fakeDb(seated: boolean) {
  const query = vi.fn(async (sql: string) => {
    if (sql.includes('FROM sessions'))
      return {
        rows: [
          {
            name: 'Table',
            catalog_version: null,
            catalog_snapshot: null,
            premise: null,
            adventure_id: null,
            character: null,
          },
        ],
      };
    if (sql.includes("type='SeatJoined'"))
      return { rows: seated ? [{ '?column?': 1 }] : [] };
    throw new Error(`unexpected query: ${sql}`);
  });
  return { query };
}

const request = {
  sessionId: randomUUID(),
  accountId: randomUUID(),
  actionId: randomUUID(),
  state: { characters: {} },
} as unknown as Parameters<ProductionSoloTurnRunner['run']>[0];

describe('solo turn seat gate', () => {
  it('rejects an account with no seat record even when no characters are configured', async () => {
    const adapter = { complete: vi.fn() } as unknown as LlmAdapter;
    const runner = new ProductionSoloTurnRunner(
      fakeDb(false),
      undefined,
      undefined,
      undefined,
      adapter,
    );
    await expect(runner.run(request, () => {})).rejects.toThrow(
      'Player is not seated at this table',
    );
    expect(adapter.complete).not.toHaveBeenCalled();
  });
});
