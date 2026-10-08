import { describe as suite, expect, test } from 'vitest';
import type { Battlemap } from '@game/schema';
import {
  describe,
  threatsWithin,
  type DescribeState,
} from '../src/map/describe.js';

const map: Battlemap = {
  mapId: 'quick-start',
  w: 8,
  h: 8,
  palette: [
    {
      terrainId: 'grass',
      moveCost: 1,
      blocksMove: false,
      blocksSight: false,
      cover: 'none',
      elevation: 0,
    },
    {
      terrainId: 'barrel',
      moveCost: 1,
      blocksMove: false,
      blocksSight: false,
      cover: 'half',
      elevation: 0,
    },
  ],
  cells: [0, 64],
  edges: [],
  features: [
    {
      featureId: 'barrel',
      kind: 'barrel',
      cells: [{ x: 4, y: 1 }],
      tags: ['half-cover'],
    },
  ],
  markers: [],
  zones: [],
  diagonalRule: '5ft',
};
const makeState = (
  entities: DescribeState['entities'] = [
    { id: 'hero', name: 'You', pos: { x: 1, y: 1 }, size: 1, team: 'party' },
    {
      id: 'goblin-2',
      name: 'Goblin 2',
      pos: { x: 4, y: 1 },
      size: 1,
      team: 'enemy',
    },
    {
      id: 'brin',
      name: 'Ally Brin',
      pos: { x: 1, y: 3 },
      size: 1,
      team: 'party',
    },
  ],
) => ({ map, entities, resources: { hero: { movementLeft: 25 } } });

suite('describe', () => {
  test('quick-start description snapshots each verbosity', () => {
    const state = makeState();
    expect(
      describe(state, 'hero', { verbosity: 'brief' }),
    ).toMatchInlineSnapshot(
      `"Ally Brin is 10 ft south. Goblin 2 is 15 ft east (half cover)."`,
    );
    expect(
      describe(state, 'hero', { verbosity: 'standard' }),
    ).toMatchInlineSnapshot(
      `"You are at B2. 25 ft movement remaining. Ally Brin is 10 ft south. Goblin 2 is 15 ft east (half cover)."`,
    );
    expect(
      describe(state, 'hero', { verbosity: 'full' }),
    ).toMatchInlineSnapshot(
      `"You are at B2. 25 ft movement remaining. Ally Brin is 10 ft south. Goblin 2 is 15 ft east among barrel (half cover) (half cover). Threats within 30 ft: Goblin 2."`,
    );
  });
  test('is stable under entity insertion order', () => {
    const entities = makeState().entities;
    const expected = describe(makeState(entities), 'hero', {
      verbosity: 'full',
    });
    for (const order of [
      entities.toReversed(),
      [entities[1]!, entities[2]!, entities[0]!],
    ])
      expect(describe(makeState(order), 'hero', { verbosity: 'full' })).toBe(
        expected,
      );
  });
  test('never includes entities hidden from the viewer', () => {
    const state = makeState([
      ...makeState().entities,
      {
        id: 'assassin',
        name: 'Hidden assassin',
        pos: { x: 2, y: 1 },
        size: 1,
        team: 'enemy',
        hidden: true,
      },
      {
        id: 'unseen',
        name: 'Unseen guard',
        pos: { x: 2, y: 2 },
        size: 1,
        team: 'enemy',
        visibleTo: ['someone-else'],
      },
    ]);
    expect(describe(state, 'hero', { verbosity: 'full' })).not.toContain(
      'assassin',
    );
    expect(describe(state, 'hero', { verbosity: 'full' })).not.toContain(
      'Unseen guard',
    );
    expect(threatsWithin(state, 'hero')).not.toContain('assassin');
  });
});
