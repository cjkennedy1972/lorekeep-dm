import { describe, expect, it } from 'vitest';
import { runAccountDeletions } from '../../src/retention/jobs/accountDeletion.js';

describe('runAccountDeletions filter', () => {
  it('rejects an empty account filter instead of sweeping nothing', async () => {
    await expect(
      runAccountDeletions({ db: {} as never, log: () => {} } as never, []),
    ).rejects.toThrow('Empty account filter');
  });
});
