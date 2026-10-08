import { describe, expect, test } from 'vitest';
import type { Battlemap } from '@game/schema';
import { loadCatalog } from '../src/catalog-node.js';
import {
  ADVENTURE_MAX_MONSTER_CR,
  validateAdventure,
} from '../src/adventure/validate.js';

const catalog = loadCatalog();
const map: Battlemap = {
  mapId: 'test-map',
  w: 3,
  h: 3,
  palette: [
    {
      terrainId: 'floor',
      moveCost: 1,
      blocksMove: false,
      blocksSight: false,
      cover: 'none',
      elevation: 0,
    },
    {
      terrainId: 'stone-wall',
      moveCost: 1,
      blocksMove: true,
      blocksSight: true,
      cover: 'full',
      elevation: 0,
    },
  ],
  cells: [0, 9],
  edges: [],
  features: [],
  markers: [
    { markerId: 'party', cell: { x: 0, y: 0 }, label: 'Party' },
    { markerId: 'foes', cell: { x: 2, y: 2 }, label: 'Foes' },
  ],
  zones: [
    {
      zoneId: 'spawn',
      kind: 'spawn',
      cells: [
        { x: 0, y: 0 },
        { x: 2, y: 2 },
      ],
    },
  ],
};
const valid = () => ({
  id: 'sample',
  title: 'Sample adventure',
  premise: 'A quiet mystery.',
  toneLine: 'Hopeful.',
  startingSceneId: 'opening',
  scenes: [
    {
      id: 'opening',
      title: 'Opening',
      text: 'A bell rings.',
      nextSceneIds: ['finale'],
      encounterIds: ['e1'],
      npcIds: ['guide'],
    },
    { id: 'finale', title: 'Finale', text: 'Dawn arrives.' },
  ],
  npcs: [
    {
      id: 'guide',
      name: 'Mira Fen',
      role: 'guide',
      disposition: 'helpful',
      facts: ['Knows the road.'],
    },
  ],
  encounters: [
    {
      id: 'e1',
      monsterIds: ['monster:bandit'],
      mapId: 'test-map',
      partySpawnMarkerId: 'party',
      enemySpawnMarkerId: 'foes',
      rewards: [],
      questHooks: [],
    },
  ],
  maps: [map],
  monsterIds: ['monster:bandit'],
  spellIds: ['spell:acid-splash'],
  itemIds: ['equipment:acid'],
});
const codes = (input: unknown) => {
  const result = validateAdventure(input, catalog);
  return result.ok ? [] : result.errors.map((issue) => issue.code);
};

describe('adventure validation', () => {
  test('accepts a complete adventure using the real catalog', () => {
    expect(validateAdventure(valid(), catalog).ok).toBe(true);
  });
  test('rejects dangling scene/encounter/map/monster/spell/item refs', () => {
    const broken = valid();
    broken.scenes[0]!.nextSceneIds = ['missing-scene'];
    broken.scenes[0]!.encounterIds = ['missing-encounter'];
    broken.encounters[0]!.mapId = 'missing-map';
    broken.encounters[0]!.monsterIds = ['monster:unknown'];
    broken.monsterIds = ['monster:unknown'];
    broken.spellIds = ['spell:unknown'];
    broken.itemIds = ['equipment:unknown'];
    expect(codes(broken)).toEqual(
      expect.arrayContaining([
        'DANGLING_SCENE_REF',
        'DANGLING_ENCOUNTER_REF',
        'DANGLING_MAP_REF',
        'DANGLING_MONSTER_REF',
        'DANGLING_SPELL_REF',
        'DANGLING_ITEM_REF',
      ]),
    );
  });
  test('rejects unreachable scenes', () => {
    const broken = valid();
    broken.scenes.push({ id: 'orphan', title: 'Orphan', text: 'Here.' });
    expect(codes(broken)).toContain('UNREACHABLE_SCENE');
  });
  test('rejects battlemaps failing the existing map validator', () => {
    const broken = valid();
    broken.maps[0]!.cells = [0, 1];
    expect(codes(broken)).toContain('INVALID_MAP');
  });
  test('rejects monsters above CR 5 scope', () => {
    const broken = valid();
    const outOfScope = {
      ...catalog.entries.find((entry) => entry.kind === 'monster')!,
      cr: ADVENTURE_MAX_MONSTER_CR + 1,
    };
    const catalogWithOutOfScope = {
      ...catalog,
      get: (kind: string, id: string) =>
        id === outOfScope.id ? outOfScope : catalog.get(kind as never, id),
    };
    broken.encounters[0]!.monsterIds = [outOfScope.id];
    const result = validateAdventure(
      broken,
      catalogWithOutOfScope as typeof catalog,
    );
    expect(result.ok ? [] : result.errors.map((issue) => issue.code)).toContain(
      'MONSTER_OUT_OF_SCOPE',
    );
  });
  test('rejects separated spawn markers', () => {
    const broken = valid();
    broken.maps[0]!.markers = [
      { markerId: 'party', cell: { x: 0, y: 0 }, label: 'Party' },
      { markerId: 'foes', cell: { x: 2, y: 2 }, label: 'Foes' },
    ];
    broken.maps[0]!.zones = [
      { zoneId: 'party-zone', kind: 'spawn', cells: [{ x: 0, y: 0 }] },
      { zoneId: 'enemy-zone', kind: 'spawn', cells: [{ x: 2, y: 2 }] },
    ];
    broken.maps[0]!.edges = [
      { a: { x: 0, y: 0 }, b: { x: 1, y: 0 }, kind: 'wall' },
      { a: { x: 1, y: 0 }, b: { x: 2, y: 0 }, kind: 'wall' },
      { a: { x: 0, y: 1 }, b: { x: 1, y: 1 }, kind: 'wall' },
      { a: { x: 1, y: 1 }, b: { x: 2, y: 1 }, kind: 'wall' },
      { a: { x: 0, y: 2 }, b: { x: 1, y: 2 }, kind: 'wall' },
      { a: { x: 1, y: 2 }, b: { x: 2, y: 2 }, kind: 'wall' },
      { a: { x: 0, y: 0 }, b: { x: 0, y: 1 }, kind: 'wall' },
      { a: { x: 1, y: 0 }, b: { x: 1, y: 1 }, kind: 'wall' },
      { a: { x: 2, y: 0 }, b: { x: 2, y: 1 }, kind: 'wall' },
      { a: { x: 0, y: 1 }, b: { x: 0, y: 2 }, kind: 'wall' },
      { a: { x: 1, y: 1 }, b: { x: 1, y: 2 }, kind: 'wall' },
      { a: { x: 2, y: 1 }, b: { x: 2, y: 2 }, kind: 'wall' },
    ];
    expect(validateAdventure(broken, catalog)).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([
        expect.objectContaining({ code: 'UNREACHABLE_SPAWN' }),
      ]),
    });
  });
  test('rejects illegal spawn cells', () => {
    const broken = valid();
    broken.maps[0]!.markers[0]!.cell = { x: 99, y: 0 };
    expect(codes(broken)).toContain('INVALID_SPAWN');
  });
  test('scans adventure content against the checked-in denylist data', () => {
    const broken = valid();
    broken.title = 'Journey to Waterdeep';
    expect(codes(broken)).toContain('DENYLISTED_TERM');
  });
});
