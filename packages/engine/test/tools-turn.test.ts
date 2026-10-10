import { describe, expect, test } from 'vitest';
import type { Ability } from '@game/schema';
import { loadCatalog } from '../src/catalog-node.js';
import type { CharacterInput } from '../src/character/types.js';
import { executeAttack } from '../src/tools/attack.js';

const catalog = loadCatalog();
const actor = (id: string): CharacterInput => ({
  id,
  name: id,
  speciesId: 'species:human',
  classId: 'class:wizard',
  backgroundId: 'background:sage',
  level: 2,
  abilities: {
    str: 10,
    dex: 14,
    con: 12,
    int: 16,
    wis: 10,
    cha: 10,
  } satisfies Record<Ability, number>,
  proficiencies: { skills: ['stealth'], saves: ['int', 'wis'], tools: [] },
  equipment: [],
  spellsKnown: [],
  spellsPrepared: [],
  slots: {},
  hp: { current: 10, max: 10, temp: 0 },
  conditions: [],
});
const rng = { seed: 1n, cursor: 0 } as never;
const attackState = (combat?: unknown) => ({
  actors: { ent_hero: actor('ent_hero'), ent_goblin: actor('ent_goblin') },
  attacks: {
    'srd:attack/shortsword': {
      id: 'srd:attack/shortsword',
      ownerId: 'ent_hero',
      attackBonus: 5,
      damage: '1d6+3',
      damageType: 'piercing',
      targetAc: 10,
      reachFt: 5,
      targetKind: 'monster' as const,
    },
  },
  hp: { ent_hero: 10, ent_goblin: 8 },
  ac: {},
  catalog,
  conditions: {},
  combat,
});
const attackArgs = {
  attackerId: 'ent_hero',
  targetId: 'ent_goblin',
  attackId: 'srd:attack/shortsword',
};
const turnOf = (activeEntityId: string, action = true) => ({
  activeEntityId,
  resources: {
    ent_hero: { action, bonusAction: true, reaction: true, movementRemaining: 30 },
    ent_goblin: { action: true, bonusAction: true, reaction: true, movementRemaining: 30 },
  },
});

describe('attack turn and action economy', () => {
  test('rejects an attack by an actor who is not active', () => {
    const result = executeAttack(attackState(turnOf('ent_goblin')), attackArgs, rng);
    expect(result).toMatchObject({ ok: false, error: 'not-actors-turn' });
  });

  test('rejects a second action in the same turn', () => {
    const result = executeAttack(attackState(turnOf('ent_hero', false)), attackArgs, rng);
    expect(result).toMatchObject({ ok: false, error: 'action-spent' });
  });
});
