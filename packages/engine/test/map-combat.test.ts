import { describe, expect, test } from 'vitest';
import type { Battlemap, GridPos } from '@game/schema';
import { attack } from '../src/combat/attack.js';
import { castSpell } from '../src/combat/spells.js';
import { loadCatalog } from '../src/catalog/load.js';
import type { CharacterInput } from '../src/character/types.js';

const c = (x: number, y: number): GridPos => ({ x, y });
const floor = {
  terrainId: 'floor',
  moveCost: 1,
  blocksMove: false,
  blocksSight: false,
  cover: 'none' as const,
  elevation: 0,
};
const wall = {
  terrainId: 'wall',
  moveCost: 1,
  blocksMove: true,
  blocksSight: true,
  cover: 'full' as const,
  elevation: 0,
};
function mapWithWall(): Battlemap {
  return {
    mapId: 'combat-test',
    w: 12,
    h: 12,
    palette: [floor, wall],
    cells: [0, 144],
    edges: [],
    features: [],
    markers: [],
    zones: [],
    diagonalRule: '5ft',
  };
}
const catalog = loadCatalog();
const caster: CharacterInput = {
  id: 'mage',
  name: 'Mage',
  speciesId: '',
  classId: 'class:wizard',
  backgroundId: '',
  level: 5,
  abilities: { str: 8, dex: 14, con: 14, int: 18, wis: 10, cha: 10 },
  proficiencies: { skills: [], saves: ['int', 'wis'], tools: [] },
  equipment: [],
  spellsKnown: ['spell:fireball'],
  spellsPrepared: ['spell:fireball'],
  slots: { '3': { max: 2, used: 0 } },
  hp: { current: 20, max: 20, temp: 0 },
  conditions: [],
};
const target = (id: string) => ({
  id,
  hp: 100,
  maxHp: 100,
  ac: 12,
  abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 },
});

describe('map-aware combat', () => {
  test('Fireball resolves a save for every creature in its sphere and lists those same ids', () => {
    const map = mapWithWall();
    const placements = [
      { id: 'mage', pos: c(1, 1), size: 1 },
      { id: 'goblin-a', pos: c(4, 1), size: 1 },
      { id: 'goblin-b', pos: c(4, 2), size: 1 },
      { id: 'blocked', pos: c(8, 1), size: 1 },
    ];
    // Fireball anchor is the center of the creatures; wall terrain between this point and `blocked`.
    map.cells = [0, 17, 1, 1, 0, 126];
    const r = castSpell({
      caster,
      target: { kind: 'anchor', pos: c(4, 1) },
      spellId: 'spell:fireball',
      slotLevel: 3,
      seed: 42,
      catalog,
      map: {
        map,
        caster: placements[0]!,
        entities: placements,
        targets: [target('goblin-a'), target('goblin-b'), target('blocked')],
      },
    });
    expect(r).toHaveProperty('ok', true);
    if (!('ok' in r)) return;
    const area = r.events.find((e) => e.type === 'AreaResolved');
    expect(area).toMatchObject({ affected: ['goblin-a', 'goblin-b'] });
    expect(
      r.events
        .filter((e) => e.type === 'RollEvent' && e.kind === 'save')
        .map((e) => e.entityId),
    ).toEqual(['goblin-a', 'goblin-b']);
    expect(r.state.hp['goblin-a']).toBeDefined();
    expect(r.state.hp['goblin-b']).toBeDefined();
    const damageRolls = r.events.filter(
      (e) => e.type === 'RollEvent' && e.kind === 'damage',
    );
    expect(damageRolls).toHaveLength(1);
    const damage = damageRolls[0]!;
    const hpChanges = r.events.filter(
      (e) => e.type === 'HpChanged' && e.kind === 'damage',
    );
    expect(hpChanges).toHaveLength(2);
    expect(hpChanges.map((e) => e.amount)).toEqual(
      hpChanges.map((e) =>
        e.entityId === 'goblin-a' && damage.type === 'RollEvent'
          ? Math.floor(damage.breakdown.total / 2)
          : damage.type === 'RollEvent'
            ? damage.breakdown.total
            : 0,
      ),
    );
  });

  test('area spell shares one damage roll while successful saves halve it individually', () => {
    const map = mapWithWall();
    const placements = [
      { id: 'mage', pos: c(1, 1), size: 1 },
      { id: 'failed-a', pos: c(4, 1), size: 1 },
      { id: 'saved', pos: c(4, 2), size: 1 },
      { id: 'failed-b', pos: c(4, 3), size: 1 },
    ];
    map.cells = [0, 17, 1, 1, 0, 126];
    const r = castSpell({
      caster,
      target: { kind: 'anchor', pos: c(4, 1) },
      spellId: 'spell:fireball',
      slotLevel: 3,
      seed: 8,
      catalog,
      map: {
        map,
        caster: placements[0]!,
        entities: placements,
        targets: [
          target('failed-a'),
          {
            ...target('saved'),
            abilities: { str: 10, dex: 30, con: 10, int: 10, wis: 10, cha: 10 },
          },
          target('failed-b'),
        ],
      },
    });
    expect(r).toHaveProperty('ok', true);
    if (!('ok' in r)) return;
    const rolls = r.events.filter((e) => e.type === 'RollEvent');
    const damageRolls = rolls.filter((e) => e.kind === 'damage');
    expect(damageRolls).toHaveLength(1);
    const total =
      damageRolls[0]!.type === 'RollEvent'
        ? damageRolls[0]!.breakdown.total
        : 0;
    const hpChanges = r.events.filter(
      (e) => e.type === 'HpChanged' && e.kind === 'damage',
    );
    expect(hpChanges.map((e) => [e.entityId, e.amount])).toEqual([
      ['failed-a', total],
      ['failed-b', total],
      ['saved', Math.floor(total / 2)],
    ]);
  });

  test('mapped attack uses long-range disadvantage and records range and cover facts', () => {
    const result = attack({
      attackerId: 'a',
      targetId: 'b',
      attackId: 'bow',
      seed: 9,
      attackBonus: 4,
      damage: '1d6',
      damageType: 'piercing',
      targetAc: 10,
      target: { hp: 20, kind: 'monster' },
      map: {
        map: mapWithWall(),
        attacker: { pos: c(1, 1), size: 1 },
        target: { pos: c(9, 1), size: 1 },
        range: { normalFt: 25, longFt: 100 },
      },
    });
    expect(result).toHaveProperty('ok', true);
    if (!('ok' in result)) return;
    const roll = result.events[0];
    expect(roll).toMatchObject({ mapFacts: { distanceFt: 40, cover: 'none' } });
    expect(roll.type === 'RollEvent' && roll.breakdown.dice).toHaveLength(2);
    expect(
      roll.type === 'RollEvent' && roll.breakdown.dice.filter((d) => d.kept),
    ).toHaveLength(1);
    expect(
      roll.type === 'RollEvent' && roll.breakdown.modifiers,
    ).toContainEqual({ label: 'disadvantage', value: 0 });
  });

  test('full cover blocks attacks and excludes creatures from area resolution', () => {
    const map = mapWithWall();
    map.cells = [0, 17, 1, 1, 0, 126];
    const result = attack({
      attackerId: 'a',
      targetId: 'b',
      attackId: 'bow',
      seed: 1,
      attackBonus: 5,
      damage: '1d6',
      damageType: 'piercing',
      targetAc: 10,
      target: { hp: 10, kind: 'monster' },
      map: {
        map,
        attacker: { pos: c(1, 1), size: 1 },
        target: { pos: c(8, 1), size: 1 },
        range: { normalFt: 100 },
      },
    });
    expect(result).toMatchObject({
      error: expect.stringContaining('full cover'),
    });
  });
});
