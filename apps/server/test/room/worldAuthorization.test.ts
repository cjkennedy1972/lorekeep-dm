import { describe, expect, it } from 'vitest';
import { worldMutationRejection } from '../../src/room/productionTurnRunner.js';

describe('shared-world mutation authorization', () => {
  it('rejects every registry mutation from a non-host seated player', () => {
    for (const name of [
      'upsert_npc',
      'upsert_location',
      'update_quest',
      'set_flag',
      'log_ruling',
    ])
      expect(worldMutationRejection(name, false)?.error).toBe('forbidden');
  });
  it('allows the host and leaves non-registry tools alone', () => {
    expect(worldMutationRejection('upsert_npc', true)).toBeUndefined();
    expect(worldMutationRejection('attack', false)).toBeUndefined();
  });
});
