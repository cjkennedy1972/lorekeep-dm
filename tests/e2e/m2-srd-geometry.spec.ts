import { describe, expect, test } from 'vitest';
import { rleEncode, type Battlemap, type GridPos } from '@game/schema';
import {
  areaCells,
  affectedEntities,
  cellDistance,
  coverBetween,
  distance,
  castSpell,
  reachable,
  type AreaTemplate,
  type CharacterInput,
} from '@game/rules-engine';
import { loadCatalog } from '@game/rules-engine/catalog-node';

// M2-01: engine geometry vs SRD 5.2.1 (CC-BY). Page numbers are the printed
// page of SRD_CC_v5.2.1.pdf; the report is docs/plan/verification/m2-01-srd-geometry.md.
//
// These tests pin SRD behaviour and run in the normal suite.
const mismatch = test;
const match = test;

const c = (x: number, y: number): GridPos => ({ x, y });
const key = (p: GridPos) => `${p.x},${p.y}`;
const keys = (cells: readonly GridPos[]) => new Set(cells.map(key));

const PALETTE = [
  ['floor', false, false, 'none'],
  ['pillar', true, true, 'full'],
  ['half', false, false, 'half'],
  ['tq', false, false, 'three-quarters'],
  // a Wall of Force / glass wall: Total Cover that does not block sight
  ['glass', true, false, 'full'],
  // fog: blocks sight but is not an obstruction providing Total Cover
  ['fog', false, true, 'none'],
] as const;
type Terrain = (typeof PALETTE)[number][0];

function makeMap(
  w: number,
  h: number,
  put: Partial<Record<Terrain, GridPos[]>> = {},
  opts: {
    walls?: [GridPos, GridPos][];
    diagonalRule?: Battlemap['diagonalRule'];
    moveCost2?: GridPos[];
  } = {},
): Battlemap {
  const names = PALETTE.map((p) => p[0]);
  const grid = new Array<number>(w * h).fill(0);
  for (const [name, cells] of Object.entries(put))
    for (const p of cells ?? [])
      grid[p.y * w + p.x] = names.indexOf(name as Terrain);
  const palette: Battlemap['palette'] = PALETTE.map(
    ([terrainId, blocksMove, blocksSight, cover]) => ({
      terrainId,
      moveCost: 1,
      blocksMove: terrainId === 'pillar' || blocksMove,
      blocksSight,
      cover,
      elevation: 0,
    }),
  );
  palette.push({
    terrainId: 'rubble',
    moveCost: 2,
    blocksMove: false,
    blocksSight: false,
    cover: 'none',
    elevation: 0,
  });
  for (const p of opts.moveCost2 ?? [])
    grid[p.y * w + p.x] = palette.length - 1;
  return {
    mapId: 'm2-01',
    w,
    h,
    palette,
    cells: rleEncode(grid),
    edges: (opts.walls ?? []).map(([a, b]) => ({
      a,
      b,
      kind: 'wall' as const,
    })),
    features: [],
    markers: [],
    zones: [],
    diagonalRule: opts.diagonalRule ?? '5ft',
  };
}

const tpl = (t: Record<string, unknown>) => t as unknown as AreaTemplate;
const unit = (pos: GridPos) => ({ pos, size: 1 });

// ---------------------------------------------------------------------------
// Diagonal movement and ranges: SRD p.13 "Playing on a Grid"
// ---------------------------------------------------------------------------
describe('SRD p.13 grid: squares, diagonals, corners, ranges', () => {
  match('MATCH: a diagonal step costs 1 square = 5 ft (default rule)', () => {
    expect(cellDistance(c(0, 0), c(1, 1))).toBe(5);
    expect(cellDistance(c(0, 0), c(3, 3))).toBe(15);
    expect(cellDistance(c(0, 0), c(4, 2))).toBe(20);
  });

  match('MATCH: a map without diagonalRule defaults to 5ft', async () => {
    const { BattlemapSchema } = await import('@game/schema');
    const rest: Record<string, unknown> = { ...makeMap(3, 3) };
    delete rest.diagonalRule;
    expect(BattlemapSchema.parse(rest).diagonalRule).toBe('5ft');
  });

  match('MATCH: real movement pays 5 ft per diagonal step', () => {
    const map = makeMap(15, 15);
    const mover = { id: 'p', pos: c(2, 2), size: 1, team: 'a' };
    const cells = reachable(
      { map, entities: [mover], resources: { p: { movementLeft: 30 } } },
      'p',
    );
    if ('error' in cells) throw new Error(cells.error);
    const at = (x: number, y: number) =>
      cells.find((r) => r.cell.x === x && r.cell.y === y);
    expect(at(8, 8)?.cost).toBe(30); // six diagonal steps on a Speed 30 budget
    expect(at(9, 9)).toBeUndefined();
  });

  match('MATCH: Difficult Terrain costs 2 squares to enter', () => {
    const map = makeMap(8, 3, {}, { moveCost2: [c(3, 1)] });
    const mover = { id: 'p', pos: c(2, 1), size: 1, team: 'a' };
    const cells = reachable(
      { map, entities: [mover], resources: { p: { movementLeft: 30 } } },
      'p',
    );
    if ('error' in cells) throw new Error(cells.error);
    expect(cells.find((r) => r.cell.x === 3 && r.cell.y === 1)?.cost).toBe(10);
  });

  match(
    'MATCH: range counts squares from an adjacent square (adjacent = 5 ft)',
    () => {
      expect(distance(unit(c(0, 0)), unit(c(1, 0)))).toBe(5);
      expect(distance(unit(c(0, 0)), unit(c(1, 1)))).toBe(5);
      expect(distance(unit(c(0, 0)), unit(c(6, 2)))).toBe(30);
      expect(distance({ pos: c(0, 0), size: 2 }, unit(c(3, 0)))).toBe(10);
    },
  );

  match('MATCH: diagonal movement cannot cross the corner of a wall', () => {
    // wall segment between (6,5) and (6,6) ends at the corner shared by (5,5)->(6,6)
    const map = makeMap(12, 12, {}, { walls: [[c(6, 5), c(6, 6)]] });
    const mover = { id: 'p', pos: c(5, 5), size: 1, team: 'a' };
    const cells = reachable(
      { map, entities: [mover], resources: { p: { movementLeft: 5 } } },
      'p',
    );
    if ('error' in cells) throw new Error(cells.error);
    expect(cells.some((r) => r.cell.x === 6 && r.cell.y === 6)).toBe(false);
  });

  mismatch(
    'SRD p.13 Corners): diagonal movement cannot pass between two blocking flank spaces',
    () => {
      const map = makeMap(12, 12, { pillar: [c(6, 5), c(5, 6)] });
      const mover = { id: 'p', pos: c(5, 5), size: 1, team: 'a' };
      const cells = reachable(
        { map, entities: [mover], resources: { p: { movementLeft: 5 } } },
        'p',
      );
      if ('error' in cells) throw new Error(cells.error);
      // Both orthogonal flank spaces are blocked; diagonal movement cannot squeeze through.
      expect(cells.some((r) => r.cell.x === 6 && r.cell.y === 6)).toBe(false);
    },
  );
});

// ---------------------------------------------------------------------------
// Cover: SRD p.15 (Cover table), p.179 (glossary "Cover")
// ---------------------------------------------------------------------------
describe('SRD p.15 / p.179 cover', () => {
  const a = unit(c(2, 5));
  const b = unit(c(8, 5));

  match.each([
    ['half', 'half', 2],
    ['tq', 'three-quarters', 5],
  ] as const)(
    'MATCH: %s obstacle gives %s cover, +%i AC and Dexterity saves',
    (terrain, grade, bonus) => {
      const r = coverBetween(makeMap(12, 11, { [terrain]: [c(5, 5)] }), a, b);
      expect(r.grade).toBe(grade);
      expect(r.acBonus).toBe(bonus);
      expect(r.saveBonus).toBe(bonus);
      expect(r.targetable).toBe(true);
    },
  );

  match(
    'MATCH: Total Cover (full obstacle or wall) means cannot be targeted',
    () => {
      expect(
        coverBetween(
          makeMap(12, 11, { pillar: [c(5, 4), c(5, 5), c(5, 6)] }),
          a,
          b,
        ).targetable,
      ).toBe(false);
      const wall = makeMap(12, 11, {}, { walls: [[c(5, 5), c(6, 5)]] });
      expect(coverBetween(wall, a, b).targetable).toBe(false);
    },
  );

  match(
    'MATCH: multiple sources use the most protective degree, never added',
    () => {
      const r = coverBetween(
        makeMap(12, 11, { half: [c(4, 5), c(6, 5)], tq: [c(5, 5)] }),
        a,
        b,
      );
      expect(r.grade).toBe('three-quarters');
      expect(r.acBonus).toBe(5);
      const two = coverBetween(
        makeMap(12, 11, { half: [c(4, 5), c(6, 5)] }),
        a,
        b,
      );
      expect(two.acBonus).toBe(2);
    },
  );

  mismatch(
    'SRD p.15 Cover table): another creature that covers at least half of the target gives Half Cover; engine ignores creatures',
    () => {
      const r = coverBetween(makeMap(12, 11), a, b, [
        { id: 'ogre', pos: c(5, 5), size: 1 },
      ]);
      expect(r.grade).toBe('half');
      expect(r.acBonus).toBe(2);
    },
  );

  mismatch(
    "SRD p.15 + p.177): area effects grant cover from an obstacle between origin and target (Dex save +2); engine reads only the target's own cell",
    () => {
      const map = makeMap(15, 11, { half: [c(4, 5)] });
      const target = { id: 't', pos: c(6, 5), size: 1 };
      const cells = areaCells(map, { shape: 'sphere', size: 20 }, c(2, 5));
      expect(keys(cells).has('6,5')).toBe(true);
      const [hit] = affectedEntities(
        cells,
        { map, entities: [target] },
        c(2, 5),
      );
      expect(hit?.saveBonus).toBe(2);
    },
  );

  mismatch(
    'SRD p.15): cover adds to Dexterity saving throws only; engine adds the area cover bonus to every save ability (spells.ts)',
    () => {
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
        spellsKnown: ['spell:stinking-cloud'],
        spellsPrepared: ['spell:stinking-cloud'],
        slots: { '3': { max: 2, used: 0 } },
        hp: { current: 20, max: 20, temp: 0 },
        conditions: [],
      };
      const foe = {
        id: 'foe',
        hp: 100,
        maxHp: 100,
        ac: 12,
        abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 },
      };
      // Stinking Cloud is a Constitution save. Same seed, same d20; only the terrain
      // under the target differs.
      const conTotal = (put: Partial<Record<Terrain, GridPos[]>>) => {
        const map = makeMap(15, 11, put);
        const placements = [
          { id: 'mage', pos: c(1, 5), size: 1 },
          { id: 'foe', pos: c(6, 5), size: 1 },
        ];
        const r = castSpell({
          caster,
          target: { kind: 'anchor', pos: c(6, 5) },
          spellId: 'spell:stinking-cloud',
          slotLevel: 3,
          seed: 7,
          catalog: loadCatalog(),
          map: {
            map,
            caster: placements[0]!,
            entities: placements,
            targets: [foe],
          },
        });
        if (!('ok' in r)) throw new Error(r.error);
        const save = r.events.find(
          (e) => e.type === 'RollEvent' && e.kind === 'save',
        );
        if (save?.type !== 'RollEvent') throw new Error('no save roll');
        return save.breakdown.total;
      };
      expect(conTotal({ half: [c(6, 5)] })).toBe(conTotal({}));
    },
  );
});

// ---------------------------------------------------------------------------
// Clear path / line of effect: SRD p.106 (Targets), p.177 (Area of Effect)
// ---------------------------------------------------------------------------
describe('SRD p.106 clear path and p.177 area-of-effect blocking', () => {
  match(
    'MATCH: a spell target behind Total Cover is not targetable, half cover is',
    () => {
      const a = unit(c(2, 5));
      const b = unit(c(8, 5));
      expect(
        coverBetween(
          makeMap(12, 11, { pillar: [c(5, 4), c(5, 5), c(5, 6)] }),
          a,
          b,
        ).targetable,
      ).toBe(false);
      expect(
        coverBetween(makeMap(12, 11, { half: [c(5, 5)] }), a, b).targetable,
      ).toBe(true);
    },
  );

  match(
    'MATCH: a location whose every straight line from the origin is blocked is excluded',
    () => {
      const map = makeMap(24, 21, { pillar: [c(11, 9), c(11, 10), c(11, 11)] });
      const cells = keys(
        areaCells(map, { shape: 'sphere', size: 25 }, c(8, 10)),
      );
      expect(cells.has('8,10')).toBe(true);
      expect(cells.has('10,10')).toBe(true);
      expect(cells.has('13,10')).toBe(false); // directly behind the wall of pillars
    },
  );

  mismatch(
    'SRD p.177: Total Cover (glass/Wall of Force) blocks an area even when it does not block sight',
    () => {
      const map = makeMap(24, 21, { glass: [c(11, 9), c(11, 10), c(11, 11)] });
      const cells = keys(
        areaCells(map, { shape: 'sphere', size: 25 }, c(8, 10)),
      );
      expect(cells.has('13,10')).toBe(false);
    },
  );

  mismatch(
    'SRD p.177: sight-blocking fog without Total Cover does not block an area',
    () => {
      const map = makeMap(24, 21, { fog: [c(11, 9), c(11, 10), c(11, 11)] });
      const cells = keys(
        areaCells(map, { shape: 'sphere', size: 25 }, c(8, 10)),
      );
      expect(cells.has('13,10')).toBe(true);
    },
  );

  mismatch(
    'SRD p.177: targeting and area inclusion agree on Total Cover glass',
    () => {
      const map = makeMap(24, 21, { glass: [c(11, 9), c(11, 10), c(11, 11)] });
      const targetable = coverBetween(
        map,
        unit(c(8, 10)),
        unit(c(13, 10)),
      ).targetable;
      const inArea = keys(
        areaCells(map, { shape: 'sphere', size: 25 }, c(8, 10)),
      ).has('13,10');
      expect(inArea).toBe(targetable);
    },
  );
});

// ---------------------------------------------------------------------------
// Area templates: SRD p.177 (Area of Effect), p.179 Cone/Cube, p.180 Cylinder,
// p.181 Emanation, p.184 Line, p.188 Sphere
// ---------------------------------------------------------------------------
describe('SRD area templates', () => {
  const map = makeMap(41, 41);
  const o = c(20, 20);
  const cellsOf = (t: Record<string, unknown>, dir = c(1, 0)) =>
    areaCells(map, tpl(t), o, dir);

  match(
    'MATCH (p.188 Sphere): origin included, radius is the stated distance',
    () => {
      const s = keys(cellsOf({ shape: 'sphere', size: 20 }));
      expect(s.has('20,20')).toBe(true);
      expect(s.has('24,20')).toBe(true); // 20 ft
      expect(s.has('25,20')).toBe(false); // 25 ft
      expect(s.has('20,16')).toBe(true);
      expect(s.has('20,15')).toBe(false);
    },
  );

  match(
    'MATCH (p.180 Cylinder): origin included, base radius as stated (height not modelled on the 2-D map)',
    () => {
      const cy = keys(cellsOf({ shape: 'cylinder', size: 20, height: 40 }));
      expect(cy.has('20,20')).toBe(true);
      expect(cy.has('24,20')).toBe(true);
      expect(cy.has('25,20')).toBe(false);
    },
  );

  match('MATCH (p.179 Cube): side length is the stated size', () => {
    const cube = cellsOf({ shape: 'cube', size: 15 });
    expect(cube).toHaveLength(9); // 3x3 squares = 15 ft per side
    const xs = cube.map((p) => p.x);
    expect(Math.max(...xs) - Math.min(...xs)).toBe(2);
  });

  match('MATCH (p.179 Cone): cone length is the stated maximum', () => {
    const cone = keys(cellsOf({ shape: 'cone', size: 15 }));
    expect(cone.has('23,20')).toBe(true); // 15 ft out
    expect(cone.has('24,20')).toBe(false); // 20 ft out
  });

  mismatch(
    'SRD p.179 Cone): width at a point equals its distance from the origin; engine is a 90-degree wedge, twice as wide',
    () => {
      const cone = keys(cellsOf({ shape: 'cone', size: 15 }));
      // At 5 ft, the diagonal side squares are outside the half-width.
      expect(cone.has('21,19')).toBe(false);
      expect(cone.has('21,21')).toBe(false);
      // At 15 ft, farther lateral squares remain outside the SRD width.
      expect(cone.has('23,18')).toBe(false);
      expect(cone.has('23,22')).toBe(false);
    },
  );

  mismatch(
    'SRD p.179 Cone): the point of origin is not in the cone unless the creator decides; engine always includes it',
    () => {
      expect(keys(cellsOf({ shape: 'cone', size: 15 })).has('20,20')).toBe(
        false,
      );
    },
  );

  mismatch(
    'SRD p.184 Line): the point of origin is not in the Line unless the creator decides; engine includes it and so makes Lightning Bolt 21 squares long',
    () => {
      const bolt = keys(cellsOf({ shape: 'line', size: 100, width: 5 }));
      expect(bolt.has('20,20')).toBe(false);
      expect(bolt.size).toBe(20); // 100 ft = 20 squares
    },
  );

  mismatch(
    'SRD p.184 Line): width is the stated width; a 10-ft wide Line is two squares wide, engine makes it three',
    () => {
      const line = cellsOf({ shape: 'line', size: 30, width: 10 });
      const column = line.filter((p) => p.x === 23);
      expect(column).toHaveLength(2);
    },
  );

  mismatch(
    'SRD p.184 Line + p.13): a diagonal Line is as long as stated; engine counts forward distance as dx+dy and cuts it to half',
    () => {
      const bolt = cellsOf({ shape: 'line', size: 100, width: 5 }, c(1, 1));
      const far = Math.max(...bolt.map((p) => Math.max(p.x - 20, p.y - 20)));
      expect(far).toBeGreaterThanOrEqual(14); // 100 ft is 14+ squares even by Euclid
    },
  );

  mismatch(
    'SRD p.179 Cube): a Cube extends from a point of origin on one of its faces (Thunderwave: "15-foot Cube originating from you", p.169), so the caster is not inside it; engine centres the cube on the origin',
    () => {
      const cube = keys(
        cellsOf({ shape: 'cube', size: 15, includeOrigin: false }),
      );
      expect(cube.has('20,20')).toBe(false);
      expect([...cube].every((k) => Number(k.split(',')[0]) >= 20)).toBe(true);
    },
  );

  mismatch(
    'SRD p.177 + p.181 Emanation): Emanation is one of the six area shapes (Aura of Protection, Spirit Guardians); engine has no emanation shape',
    () => {
      // 10-ft Emanation around a Medium creature at the origin: everything within 10 ft
      // of its space, not including the creature.
      const em = keys(
        cellsOf({ shape: 'emanation', size: 10, includeOrigin: false }),
      );
      expect(em.has('22,20')).toBe(true);
      expect(em.has('20,22')).toBe(true);
      expect(em.has('23,20')).toBe(false);
      expect(em.has('20,20')).toBe(false);
    },
  );

  match(
    'SRD-SILENT (p.177 / p.13): the SRD gives no rule for rasterizing templates onto grid squares; engine keeps its documented square-centre convention (existing cell-count tests in packages/engine/test/map-area.test.ts)',
    () => {
      expect(cellsOf({ shape: 'sphere', size: 5 })).toHaveLength(5);
    },
  );
});
