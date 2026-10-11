import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { checkLiveUrl } from '../../../../packages/evals/src/live.js';
import { createEgressGuard } from '../../src/llm/egress.js';

type Case = {
  id: string;
  url: string;
  allow: string[];
  expect: 'allow' | 'deny';
};

const corpus = JSON.parse(
  readFileSync(
    new URL(
      '../../../../packages/evals/data/live-url-corpus.json',
      import.meta.url,
    ),
    'utf8',
  ),
) as Case[];

const resolver = async (host: string) => [
  {
    address: host === 'localhost' ? '127.0.0.1' : '93.184.216.34',
    family: 4 as const,
  },
];

const liveVerdict = (c: Case): 'allow' | 'deny' => {
  try {
    checkLiveUrl(c.url, c.allow.join(','));
    return 'allow';
  } catch {
    return 'deny';
  }
};

describe('live URL check agrees with the egress guard (shared corpus)', () => {
  it('corpus has at least 38 cases', () => {
    expect(corpus.length).toBeGreaterThanOrEqual(38);
  });

  for (const c of corpus) {
    it(c.id, async () => {
      const guard = createEgressGuard({ allowLocalHosts: c.allow, resolver });
      const egress = await guard.validate(c.url).then(
        () => 'allow',
        () => 'deny',
      );
      expect({ egress, live: liveVerdict(c) }).toEqual({
        egress: c.expect,
        live: c.expect,
      });
    });
  }
});
