import { describe, expect, test } from 'vitest';
import type { Ability } from '@game/schema';
import { loadCatalog } from '../src/catalog-node.js';
import { seedRng } from '../src/rng.js';
import type { CharacterInput } from '../src/character/types.js';
import {
  callForRest,
  consumeItem,
  findRulings,
  grantItem,
  logRuling,
  setFlag,
  updateQuest,
  upsertLocation,
  upsertNpc,
  type WorldRegistry,
} from '../src/index.js';

const catalog = loadCatalog();
const makeCharacter = (): CharacterInput => {
  const klass = catalog.get('class', 'class:wizard')!;
  const abilities: Record<Ability, number> = {
    str: 8,
    dex: 14,
    con: 13,
    int: 15,
    wis: 10,
    cha: 15,
  };
  return {
    id: 'ent_hero',
    name: 'Hero',
    speciesId: 'species:human',
    classId: klass.id,
    backgroundId: 'background:sage',
    level: 2,
    abilities,
    proficiencies: {
      skills: [],
      saves: [...klass.saveProficiencies],
      tools: [],
    },
    equipment: [],
    spellsKnown: [],
    spellsPrepared: [],
    slots: { '1': { max: 3, used: 2 } },
    hp: { current: 2, max: 12, temp: 4 },
    hitDiceSpent: 0,
    conditions: [],
  };
};
const registry = (): WorldRegistry => ({
  npcs: {},
  locations: {},
  quests: { quest_wolf: { id: 'quest_wolf', status: 'active' } },
  flags: {},
  rulings: [],
});
const good = <T>(result: { ok: boolean; value?: T }): T => {
  if (!result.ok) throw new Error('expected success');
  return result.value as T;
};
const badCode = (result: { ok: boolean; error?: string }): string => {
  expect(result.ok).toBe(false);
  return result.error!;
};

describe('world tool executors', () => {
  test('grants and consumes only known catalog equipment without mutating the input', () => {
    const original = makeCharacter();
    const granted = good(grantItem(original, 'srd:item/rope', 2, catalog));
    expect(granted.equipment).toEqual([
      { itemId: 'equipment:rope', qty: 2, equipped: false },
    ]);
    expect(original.equipment).toEqual([]);
    const stacked = good(grantItem(granted, 'srd:item/rope', 3, catalog));
    expect(stacked.equipment[0]!.qty).toBe(5);
    expect(granted.equipment[0]!.qty).toBe(2);
    expect(badCode(grantItem(original, 'srd:item/not-real', 1, catalog))).toBe(
      'unknown-item',
    );
    expect(
      badCode(
        grantItem(original, 'srd:currency/gp', 1000, catalog, {
          lootBudgetRemaining: 10,
        }),
      ),
    ).toBe('loot-budget-exceeded');
    expect(badCode(grantItem(original, 'srd:item/rope', 0, catalog))).toBe(
      'schema-violation',
    );
    const consumed = good(consumeItem(granted, 'srd:item/rope', 1, catalog));
    expect(consumed.equipment[0]?.qty).toBe(1);
    expect(badCode(consumeItem(original, 'srd:item/rope', 1, catalog))).toBe(
      'not-in-inventory',
    );
    expect(badCode(consumeItem(granted, 'srd:item/rope', 3, catalog))).toBe(
      'insufficient-qty',
    );
    expect(
      badCode(consumeItem(granted, 'srd:item/no-such-item', 1, catalog)),
    ).toBe('unknown-item');
  });

  test('registry operations validate, return diffs, and keep facts append/supersede-only', () => {
    const world = registry();
    const npc = {
      id: 'npc_mira',
      name: 'Mira',
      role: 'Guide',
      disposition: 'friendly',
      facts: ['Lives in town'],
    } as const;
    const diff = good(upsertNpc(world, npc));
    expect(diff.after).toEqual(npc);
    expect(world.npcs).toEqual({});
    expect(
      badCode(
        upsertNpc(
          { ...world, npcs: { npc_mira: { ...npc, disposition: 'friendly' } } },
          { ...npc, facts: ['Moved away'] },
        ),
      ),
    ).toBe('fact-immutable');
    expect(badCode(upsertNpc(world, { ...npc, id: 'wrong' }))).toBe(
      'schema-violation',
    );
    expect(
      good(
        upsertNpc(world, {
          ...npc,
          facts: [...npc.facts, 'Now lives at the inn'],
        }),
      ).after.facts,
    ).toHaveLength(2);
    expect(
      good(
        upsertLocation(world, {
          id: 'loc_town',
          name: 'Town',
          role: 'Settlement',
          facts: [],
        }),
      ).kind,
    ).toBe('location');
    expect(
      good(setFlag(world, { flagId: 'flag_door', value: true })).after.value,
    ).toBe(true);
    expect(
      badCode(
        updateQuest(world, { questId: 'quest_missing', status: 'active' }),
      ),
    ).toBe('unknown-quest');
    expect(
      badCode(
        updateQuest(
          {
            ...world,
            quests: { quest_wolf: { id: 'quest_wolf', status: 'completed' } },
          },
          { questId: 'quest_wolf', status: 'active' },
        ),
      ),
    ).toBe('illegal-transition');
    expect(
      good(updateQuest(world, { questId: 'quest_wolf', status: 'completed' }))
        .after.status,
    ).toBe('completed');
  });

  test('rulings can be queried by topic', () => {
    const world = registry();
    const result = good(
      logRuling(world, {
        topic: 'Darkness',
        ruling: 'A torch sheds bright light.',
      }),
    );
    expect(result.after.id).toBe('ruling_darkness');
    expect(findRulings({ ...world, rulings: [result.after] }, 'dark')).toEqual([
      result.after,
    ]);
    expect(badCode(logRuling(world, { topic: '', ruling: 'x' }))).toBe(
      'schema-violation',
    );
  });
});

describe('rest tool executor', () => {
  test('applies the M1 short and long rest rules with seeded rolls', () => {
    const hero = { ...makeCharacter(), equipment: [], hitDiceSpent: 0 };
    const short = good(callForRest(hero, 'short', catalog, seedRng(123), 1));
    expect(short.character.hitDiceSpent).toBe(1);
    expect(short.character.hp.current).toBeGreaterThan(hero.hp.current);
    expect(hero.hp.current).toBe(2);
    const long = good(
      callForRest(
        {
          ...short.character,
          hp: { current: 1, max: 12, temp: 4 },
          slots: { '1': { max: 3, used: 2 } },
        },
        'long',
        catalog,
        short.rng,
      ),
    );
    expect(long.character.hp).toEqual({ current: 12, max: 12, temp: 0 });
    expect(long.character.slots['1']).toEqual({ max: 3, used: 0 });
    expect(long.character.hitDiceSpent).toBe(0);
    expect(badCode(callForRest(hero, 'short', catalog, seedRng(3), 3))).toBe(
      'illegal-transition',
    );
  });
});
