import { BattlemapSchema, rleEncode, type Battlemap } from '@game/schema';
import {
  affectedEntities,
  areaCells,
  coverBetween,
  path,
  reachable,
  threatenedBy,
} from '@game/rules-engine';
import { describe, expect, it } from 'vitest';
import {
  computeMapOverlays,
  DEFAULT_OVERLAY_TOGGLES,
} from '../src/features/map/overlays.js';

const map = BattlemapSchema.parse({
  mapId: 'overlay-fixture',
  w: 6,
  h: 5,
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
      terrainId: 'half-cover',
      moveCost: 1,
      blocksMove: false,
      blocksSight: false,
      cover: 'half',
      elevation: 0,
    },
  ],
  cells: rleEncode(Array.from({ length: 30 }, (_, i) => (i === 10 ? 1 : 0))),
  edges: [],
  features: [],
  markers: [],
  zones: [],
  diagonalRule: '5ft',
}) as Battlemap;
const state = {
  map,
  entities: [
    { id: 'hero', name: 'Hero', team: 'party', pos: { x: 0, y: 1 }, size: 1 },
    { id: 'ally', name: 'Ally', team: 'party', pos: { x: 2, y: 1 }, size: 1 },
    { id: 'foe', name: 'Goblin', team: 'enemy', pos: { x: 3, y: 1 }, size: 1 },
  ],
  resources: { hero: { movementLeft: 20 } },
};

describe('map overlays', () => {
  it('defaults every overlay off and enables them individually', () => {
    expect(DEFAULT_OVERLAY_TOGGLES).toEqual({
      reachable: false,
      path: false,
      threat: false,
      area: false,
      los: false,
      cover: false,
    });
    const overlay = computeMapOverlays(state, {
      entityId: 'hero',
      toggles: { reachable: true },
    });
    expect(overlay.enabled.reachable).toBe(true);
    expect(overlay.reachable).toEqual(reachable(state, 'hero'));
    expect(overlay.path).toBeUndefined();
  });
  it('matches engine reachable, area, cover, threat and path results', () => {
    const template = { shape: 'sphere' as const, size: 10 };
    const overlay = computeMapOverlays(state, {
      entityId: 'hero',
      goal: { x: 2, y: 2 },
      area: { template, origin: { x: 1, y: 1 } },
      targetId: 'foe',
      toggles: {
        reachable: true,
        path: true,
        area: true,
        threat: true,
        cover: true,
      },
    });
    expect(overlay.reachable).toEqual(reachable(state, 'hero'));
    expect(overlay.path).toEqual(path(state, 'hero', { x: 2, y: 2 }));
    expect(overlay.pathCostLabel).toBe('10 ft');
    const cells = areaCells(map, template, { x: 1, y: 1 });
    const affected = affectedEntities(cells, state, { x: 1, y: 1 });
    expect(overlay.area?.cells).toEqual(cells);
    expect(overlay.area?.affected).toEqual(affected);
    expect(overlay.area?.affectedNames).toEqual(
      affected.map(
        ({ id }) =>
          state.entities.find((entity) => entity.id === id)?.name ?? id,
      ),
    );
    expect(overlay.threatened).toEqual(
      threatenedBy(state.entities[0]!, state.entities).map(({ id }) => id),
    );
    expect(overlay.cover).toEqual(
      coverBetween(map, state.entities[0]!, state.entities[2]!),
    );
    expect(overlay.cover?.display).toBe('cover: none');
  });
  it('labels an illegal path with the engine reason and previews LOS', () => {
    const overlay = computeMapOverlays(state, {
      entityId: 'hero',
      goal: { x: 5, y: 4 },
      losTargetId: 'foe',
      toggles: { path: true, los: true },
    });
    expect(overlay.path).toEqual(path(state, 'hero', { x: 5, y: 4 }));
    expect(overlay.pathCostLabel).toBe('Illegal: unreachable');
    expect(overlay.los).toBe(true);
  });
});
