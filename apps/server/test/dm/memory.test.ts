import { describe, expect, it } from 'vitest';
import { extractMentionedRegistryFacts } from '../../src/dm/memory.js';

describe('registry entity injection', () => {
  it('matches names and aliases case-insensitively with stable ordering', () => {
    const entities = [
      {
        entityId: 'npc_zora',
        name: 'Zora',
        aliases: ['the ferryman'],
        facts: ['Keeps the east key.'],
        mentionedAt: 3,
      },
      {
        entityId: 'loc_docks',
        name: 'Old Docks',
        aliases: ['the landing'],
        facts: ['The tide cave is below.'],
        mentionedAt: 2,
      },
    ];
    expect(
      extractMentionedRegistryFacts(
        'Ask the FERRYMAN by the LANDING',
        entities,
      ),
    ).toEqual([
      {
        entityId: 'loc_docks',
        text: 'The tide cave is below.',
        mentionedAt: expect.any(Number),
      },
      {
        entityId: 'npc_zora',
        text: 'Keeps the east key.',
        mentionedAt: expect.any(Number),
      },
    ]);
  });

  it('matches whole normalized names and ignores unmentioned entities', () => {
    const result = extractMentionedRegistryFacts('The Zorax is not Zora.', [
      {
        entityId: 'npc_zora',
        name: 'Zora',
        aliases: [],
        facts: ['Known fact.'],
        mentionedAt: 0,
      },
      {
        entityId: 'npc_other',
        name: 'Other',
        aliases: [],
        facts: ['Other fact.'],
        mentionedAt: 1,
      },
    ]);
    expect(result.map((fact) => fact.entityId)).toEqual(['npc_zora']);
  });
});
