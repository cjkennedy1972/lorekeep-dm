import { describe, expect, test } from 'vitest';
import { rleEncode } from '@game/schema';
import { loadCatalog } from '../src/catalog-node.js';
import type { CharacterInput } from '../src/character/types.js';
import type { SpellMapContext } from '../src/combat/spells.js';
import { seedRng } from '../src/rng.js';
import { executeSpell } from '../src/tools/spell.js';

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
  slots: { '1': { max: 1, used: 0 } },
  hp: { current: 10, max: 10, temp: 0 },
  conditions: [],
};
const abilities = { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 };
const spellMap: SpellMapContext = {
  map: {
    mapId: 'spell-map',
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
    markers: [{ markerId: 'mk_area', cell: { x: 5, y: 5 }, label: 'area' }],
    zones: [],
    diagonalRule: '5ft',
  },
  caster: { pos: { x: 2, y: 5 }, size: 1 },
  entities: [
    { id: 'ent_hero', pos: { x: 2, y: 5 }, size: 1 },
    { id: 'ent_enemy', pos: { x: 5, y: 5 }, size: 1 },
  ],
  targets: [
    {
      id: 'ent_enemy',
      hp: 8,
      maxHp: 8,
      abilities,
    },
  ],
};
const spellArgs = {
  casterId: 'ent_hero',
  spellId: 'srd:spell/burning-hands',
  slotLevel: 1,
  target: { kind: 'anchor', ref: 'mk_area' },
};

describe('executeSpell map projection', () => {
  test('resolves area anchors from spellMap when map is unset', () => {
    const result = executeSpell(
      {
        actors: { [hero.id]: hero },
        targets: {},
        catalog,
        spellMap,
        turnId: 'turn-1',
      },
      spellArgs,
      seedRng(3),
    );

    expect(result.ok).toBe(true);
    if (result.ok)
      expect(
        result.value.events.some((event) => event.type === 'AreaResolved'),
      ).toBe(true);
  });

  test('rejects area anchors when neither spellMap nor map is set', () => {
    const result = executeSpell(
      { actors: { [hero.id]: hero }, targets: {}, catalog, turnId: 'turn-1' },
      spellArgs,
      seedRng(3),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('area-needs-anchor');
  });
});
