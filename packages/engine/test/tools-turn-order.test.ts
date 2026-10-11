import { describe, expect, test } from 'vitest';
import type { Battlemap } from '@game/schema';
import { rleEncode } from '@game/schema';
import { loadCatalog } from '../src/catalog-node.js';
import type { CharacterInput } from '../src/character/types.js';
import { seedRng } from '../src/rng.js';
import { execute } from '../src/tools/index.js';
import { executeAttack } from '../src/tools/attack.js';
import { executeSpell } from '../src/tools/spell.js';
import { executeMoveTo } from '../src/tools/movement.js';
import { emptyCombatState } from '../src/combat/state.js';

const catalog = loadCatalog();
const hero: CharacterInput = {
  id: 'ent_hero',
  name: 'Hero',
  speciesId: 'species:human',
  classId: 'class:wizard',
  backgroundId: 'background:sage',
  level: 1,
  abilities: { str: 10, dex: 16, con: 12, int: 14, wis: 10, cha: 10 },
  proficiencies: { skills: [], saves: ['int', 'wis'], tools: [] },
  equipment: [],
  spellsKnown: ['spell:burning-hands'],
  spellsPrepared: ['spell:burning-hands'],
  slots: {},
  hp: { current: 10, max: 10, temp: 0 },
  conditions: [],
};
const map = (): Battlemap => ({
  mapId: 'turn-order',
  w: 10,
  h: 10,
  palette: [
    {
      terrainId: 'floor',
      moveCost: 1,
      blocksMove: false,
      blocksSight: false,
      cover: 'none',
      elevation: 0,
    },
  ],
  cells: rleEncode(Array(100).fill(0)),
  edges: [],
  features: [],
  markers: [{ markerId: 'mk_goal', cell: { x: 2, y: 2 }, label: 'goal' }],
  zones: [],
  diagonalRule: '5ft',
});
const entities = [
  {
    id: 'ent_hero',
    name: 'Hero',
    team: 'party',
    pos: { x: 4, y: 5 },
    size: 1,
    hp: 10,
    maxHp: 10,
    ac: 12,
    speed: 30,
    dexterity: 16,
    initiativeModifier: 3,
  },
  {
    id: 'ent_guard',
    name: 'Guard',
    team: 'enemies',
    pos: { x: 5, y: 5 },
    size: 1,
    hp: 8,
    maxHp: 8,
    ac: 12,
    speed: 30,
    dexterity: 10,
    initiativeModifier: 0,
  },
];
const weapon = {
  id: 'srd:weapon/dagger',
  ownerId: 'ent_hero',
  attackBonus: 5,
  damage: '1d4',
  damageType: 'piercing',
  targetAc: 12,
  reachFt: 5,
  targetKind: 'monster' as const,
};
const guardWeapon = { ...weapon, id: 'srd:weapon/claw', ownerId: 'ent_guard' };
const state = (turnActorId?: string | null) => ({
  actors: { [hero.id]: hero },
  catalog,
  map: map(),
  entities,
  attacks: { [weapon.id]: weapon, [guardWeapon.id]: guardWeapon },
  hp: { ent_hero: 10, ent_guard: 8 },
  ac: { ent_hero: 12, ent_guard: 12 },
  targets: {
    ent_guard: {
      id: 'ent_guard',
      hp: 8,
      maxHp: 8,
      abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 },
    },
  },
  placements: {
    ent_hero: { id: 'ent_hero', x: 4, y: 5, pos: { x: 4, y: 5 }, size: 1 },
    ent_guard: { id: 'ent_guard', x: 5, y: 5, pos: { x: 5, y: 5 }, size: 1 },
  },
  combat: emptyCombatState(),
  turnId: 'turn-1',
  ...(turnActorId === undefined ? {} : { turnActorId }),
});
const errorOf = (result: { ok: boolean; error?: string }) =>
  result.ok ? undefined : result.error;

describe('out-of-turn DM tool calls', () => {
  test('attack by a combatant who is not active is rejected', () => {
    const result = executeAttack(
      state('ent_hero'),
      {
        attackerId: 'ent_guard',
        targetId: 'ent_hero',
        attackId: guardWeapon.id,
      },
      seedRng(3),
    );
    expect(errorOf(result)).toBe('not-actors-turn');
  });

  test('attack by the active combatant is allowed', () => {
    const result = executeAttack(
      state('ent_hero'),
      { attackerId: 'ent_hero', targetId: 'ent_guard', attackId: weapon.id },
      seedRng(3),
    );
    expect(result.ok).toBe(true);
  });

  test('attack with no live turn order is not gated', () => {
    const result = executeAttack(
      state(null),
      {
        attackerId: 'ent_guard',
        targetId: 'ent_hero',
        attackId: guardWeapon.id,
      },
      seedRng(3),
    );
    expect(errorOf(result)).not.toBe('not-actors-turn');
  });

  test('cast_spell by a caster who is not active is rejected', () => {
    const result = executeSpell(
      state('ent_guard'),
      {
        casterId: 'ent_hero',
        spellId: 'srd:spell/burning-hands',
        slotLevel: 1,
        target: { kind: 'entity', ref: 'ent_guard' },
      },
      seedRng(3),
    );
    expect(errorOf(result)).toBe('not-actors-turn');
  });

  test('cast_spell by the active caster is not blocked by turn order', () => {
    const result = executeSpell(
      state('ent_hero'),
      {
        casterId: 'ent_hero',
        spellId: 'srd:spell/burning-hands',
        slotLevel: 1,
        target: { kind: 'entity', ref: 'ent_guard' },
      },
      seedRng(3),
    );
    expect(errorOf(result)).not.toBe('not-actors-turn');
  });

  test('move_to by a combatant who is not active is rejected', () => {
    const result = executeMoveTo(
      { ...state('ent_guard'), map: map(), entities, resources: undefined },
      { entityId: 'ent_hero', targetRef: 'mk_goal', mode: 'within' },
    );
    expect(errorOf(result)).toBe('not-actors-turn');
  });

  test('dispatcher routes an out-of-turn attack to the same rejection', () => {
    const result = execute(
      state('ent_hero'),
      {
        name: 'attack',
        args: {
          attackerId: 'ent_guard',
          targetId: 'ent_hero',
          attackId: guardWeapon.id,
        },
      },
      seedRng(3),
    );
    expect(errorOf(result)).toBe('not-actors-turn');
  });
});
