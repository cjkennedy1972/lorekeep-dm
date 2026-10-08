import { rleEncode, type Battlemap } from '@game/schema';
import { describe, expect, test } from 'vitest';
import {
  moveAlong,
  resolveReaction,
  type MovementCommandState,
} from '../src/map/movement.js';
import { threatenedBy } from '../src/map/threat.js';

const map: Battlemap = {
  mapId: 'm',
  w: 6,
  h: 2,
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
  cells: rleEncode(Array(12).fill(0)),
  edges: [],
  features: [],
  markers: [],
  zones: [],
  diagonalRule: '5ft',
};
function state(): MovementCommandState {
  return {
    map,
    entities: [
      { id: 'mover', team: 'heroes', pos: { x: 1, y: 0 }, size: 1, hp: 20 },
      {
        id: 'orc',
        team: 'foes',
        pos: { x: 0, y: 0 },
        size: 1,
        hp: 10,
        opportunityAttack: {
          seed: 0,
          attackBonus: 40,
          damage: '1d8',
          damageType: 'slashing',
          targetAc: 1,
        },
      },
    ],
    resources: { mover: { movementLeft: 30 } },
  };
}
const route = [
  { x: 1, y: 0 },
  { x: 2, y: 0 },
  { x: 3, y: 0 },
];

describe('movement and opportunity attacks', () => {
  test('hostile leaving reach pauses once and decline resumes to the same destination/cost', () => {
    const initial = state();
    expect(threatenedBy(initial.entities[0]!, initial.entities)).toHaveLength(
      1,
    );
    const paused = moveAlong(initial, 'mover', route);
    expect('ok' in paused && paused.pending).toHaveLength(1);
    if (!('ok' in paused)) return;
    expect(
      paused.events.filter((e) => e.type === 'ReactionAvailable'),
    ).toHaveLength(1);
    const resumed = resolveReaction(
      paused.state,
      paused.pending[0]!.reactionId,
      'decline',
    );
    expect(
      'ok' in resumed &&
        resumed.state.entities.find((e) => e.id === 'mover')?.pos,
    ).toEqual({ x: 3, y: 0 });
    const direct = moveAlong(initial, 'mover', route, 'disengage');
    expect(
      'ok' in direct &&
        direct.state.entities.find((e) => e.id === 'mover')?.pos,
    ).toEqual({ x: 3, y: 0 });
    if ('ok' in resumed && 'ok' in direct)
      expect(
        paused.events
          .filter((e) => e.type === 'MovementSpent')
          .reduce((n, e) => n + e.feet, 0) +
          resumed.events
            .filter((e) => e.type === 'MovementSpent')
            .reduce((n, e) => n + e.feet, 0),
      ).toBe(
        direct.events
          .filter((e) => e.type === 'MovementSpent')
          .reduce((n, e) => n + e.feet, 0),
      );
  });
  test('disengage and forced movement suppress reactions', () => {
    for (const mode of ['disengage', 'forced'] as const) {
      const result = moveAlong(state(), 'mover', route, mode);
      expect(
        'ok' in result &&
          result.events.some((e) => e.type === 'ReactionAvailable'),
      ).toBe(false);
    }
  });
  test('hostiles without a reaction or incapacitated do not trigger', () => {
    const noReaction = state();
    noReaction.reactions = { orc: false };
    expect(
      'ok' in moveAlong(noReaction, 'mover', route) &&
        moveAlong(noReaction, 'mover', route).events.some(
          (e) => e.type === 'ReactionAvailable',
        ),
    ).toBe(false);
    const incapacitated = state();
    incapacitated.conditions = { orc: ['incapacitated'] };
    const result = moveAlong(incapacitated, 'mover', route);
    expect(
      'ok' in result &&
        result.events.some((e) => e.type === 'ReactionAvailable'),
    ).toBe(false);
  });
  test('taking an OA that drops the mover to zero does not resume path', () => {
    const s = state();
    s.entities = s.entities.map((e) =>
      e.id === 'mover' ? { ...e, hp: 1 } : e,
    );
    const paused = moveAlong(s, 'mover', route);
    if (!('ok' in paused)) throw new Error(paused.error);
    const result = resolveReaction(
      paused.state,
      paused.pending[0]!.reactionId,
      'take',
    );
    expect(
      'ok' in result &&
        result.state.entities.find((e) => e.id === 'mover')?.pos,
    ).toEqual({ x: 2, y: 0 });
    expect('ok' in result && result.state.hp?.mover).toBe(0);
  });
  test('more than one eligible hostile each gets exactly one reaction prompt', () => {
    const s = state();
    s.entities = [
      ...s.entities,
      { id: 'orc2', team: 'foes', pos: { x: 0, y: 1 }, size: 1, hp: 10 },
    ];
    const result = moveAlong(s, 'mover', route);
    expect(
      'ok' in result &&
        result.events.filter((e) => e.type === 'ReactionAvailable'),
    ).toHaveLength(2);
  });
});
