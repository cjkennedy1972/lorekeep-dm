import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { checkHardFloor } from '../../src/safety/hardFloor.js';

const boundary = JSON.parse(
  readFileSync(
    new URL(
      '../../../../packages/evals/redteam/boundary-100.json',
      import.meta.url,
    ),
    'utf8',
  ),
) as { cases: { id: string; text: string; hardFloor?: boolean }[] };

describe('hard floor vs red-team boundary dataset', () => {
  const rows = boundary.cases.filter((c) => c.hardFloor);

  it('has the 15 hard-floor rows', () => {
    expect(rows).toHaveLength(15);
  });

  it.each(rows.map((c) => [c.id, c.text] as const))(
    'blocks %s',
    (_id, text) => {
      expect(checkHardFloor(text).blocked).toBe(true);
    },
  );
});
