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
  test.each([2, 3])(
    'bump path ending at or crossing hidden cell %i',
    (destination) => {
      const s = state();
      s.entities = [
        { ...s.entities[0]!, pos: { x: 0, y: 0 } },
        { ...s.entities[1]!, pos: { x: 2, y: 0 }, hidden: true },
      ];
      const result = moveAlong(
        s,
        'mover',
        Array.from({ length: destination + 1 }, (_, x) => ({ x, y: 0 })),
      );
      expect('ok' in result).toBe(true);
      if (!('ok' in result)) return;
      expect(result.state.entities.find((e) => e.id === 'mover')?.pos).toEqual({
        x: 1,
        y: 0,
      });
      expect(result.events).toContainEqual({
        type: 'EntityRevealed',
        entityId: 'orc',
        cause: 'bump',
      });
      expect(
        result.events
          .filter((e) => e.type === 'MovementSpent')
          .reduce((n, e) => n + e.feet, 0),
      ).toBe(5);
      expect(result.state.resources?.mover?.movementLeft).toBe(25);
      expect(result.movementEnd).toBe('blocked');
    },
  );

  test('spends only walked cells when the remaining budget reaches the hidden blocker', () => {
    const s = state();
    s.entities = [
      { ...s.entities[0]!, pos: { x: 0, y: 0 } },
      { ...s.entities[1]!, pos: { x: 2, y: 0 }, hidden: true },
    ];
    s.resources = { mover: { movementLeft: 5 } };
    const result = moveAlong(s, 'mover', [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 2, y: 0 },
    ]);
    expect('ok' in result).toBe(true);
    if (!('ok' in result)) return;
    expect(result.state.entities.find((e) => e.id === 'mover')?.pos).toEqual({
      x: 1,
      y: 0,
    });
    expect(result.state.resources?.mover?.movementLeft).toBe(0);
    expect(result.events).toContainEqual({
      type: 'EntityRevealed',
      entityId: 'orc',
      cause: 'bump',
    });
    expect(
      result.events
        .filter((e) => e.type === 'MovementSpent')
        .reduce((n, e) => n + e.feet, 0),
    ).toBe(5);
  });

  test('does not reveal a hidden blocker when terrain makes its cell illegal', () => {
    const s = state();
    s.entities = [
      { ...s.entities[0]!, pos: { x: 0, y: 0 } },
      { ...s.entities[1]!, pos: { x: 2, y: 0 }, hidden: true },
    ];
    s.map = {
      ...map,
      palette: [
        ...map.palette,
        { ...map.palette[0]!, terrainId: 'wall', blocksMove: true },
      ],
      cells: rleEncode(Array.from({ length: 12 }, (_, i) => (i === 2 ? 1 : 0))),
    };
    const result = moveAlong(s, 'mover', [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 2, y: 0 },
    ]);
    expect(result).toMatchObject({ reason: 'blocked' });
    expect(s.entities.find((e) => e.id === 'orc')?.hidden).toBe(true);
  });

  test('does not reveal a hidden blocker before the preceding walked step passes budget checks', () => {
    const s = state();
    s.entities = [
      { ...s.entities[0]!, pos: { x: 0, y: 0 } },
      { ...s.entities[1]!, pos: { x: 2, y: 0 }, hidden: true },
    ];
    s.resources = { mover: { movementLeft: 0 } };
    const result = moveAlong(s, 'mover', [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 2, y: 0 },
    ]);
    expect(result).toMatchObject({ reason: 'insufficient_movement' });
    expect(s.entities.find((e) => e.id === 'orc')?.hidden).toBe(true);
  });
  test('bumping a hidden hostile reveals it and stops on the last free cell', () => {
    const s = state();
    s.entities = [
      { ...s.entities[0]!, pos: { x: 0, y: 0 } },
      { ...s.entities[1]!, pos: { x: 3, y: 0 }, hidden: true },
    ];
    const result = moveAlong(s, 'mover', [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 2, y: 0 },
      { x: 3, y: 0 },
    ]);
    expect('ok' in result).toBe(true);
    if (!('ok' in result)) return;
    expect(result.state.entities.find((e) => e.id === 'mover')?.pos).toEqual({
      x: 2,
      y: 0,
    });
    expect(result.state.entities.find((e) => e.id === 'orc')?.hidden).toBe(
      false,
    );
    expect(result.events).toContainEqual({
      type: 'EntityRevealed',
      entityId: 'orc',
      cause: 'bump',
    });
    expect(
      result.events
        .filter((e) => e.type === 'MovementSpent')
        .reduce((n, e) => n + e.feet, 0),
    ).toBe(10);
  });

  test('a hidden reactor is revealed when its opportunity attack is taken', () => {
    const s = state();
    s.entities = s.entities.map((e) =>
      e.id === 'orc' ? { ...e, hidden: true } : e,
    );
    const paused = moveAlong(s, 'mover', route);
    if (!('ok' in paused)) throw new Error('expected reaction pause');
    const result = resolveReaction(
      paused.state,
      paused.pending[0]!.reactionId,
      'take',
    );
    expect('ok' in result).toBe(true);
    if (!('ok' in result)) return;
    expect(result.state.entities.find((e) => e.id === 'orc')?.hidden).toBe(
      false,
    );
    expect(result.events).toContainEqual({
      type: 'EntityRevealed',
      entityId: 'orc',
      cause: 'opportunity',
    });
    expect(result.state.pendingReactions).toEqual({});
  });

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
    expect(resumed.events.filter((e) => e.type === 'MoveStarted')).toHaveLength(
      0,
    );
    expect('ok' in resumed && resumed.movementEnd).toBe('complete');
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

  test('an illegal remaining step ends the paused move as blocked at the current cell', () => {
    const paused = moveAlong(state(), 'mover', [...route, { x: 4, y: 0 }]);
    if (!('ok' in paused)) throw new Error('expected reaction pause');
    const blockedMap: Battlemap = {
      ...map,
      palette: [
        ...map.palette,
        { ...map.palette[0]!, terrainId: 'wall', blocksMove: true },
      ],
      cells: rleEncode(
        Array.from({ length: 12 }, (_, index) => (index === 4 ? 1 : 0)),
      ),
    };
    const resumed = resolveReaction(
      { ...paused.state, map: blockedMap },
      paused.pending[0]!.reactionId,
      'decline',
    );
    expect('ok' in resumed).toBe(true);
    if (!('ok' in resumed)) return;
    expect(resumed.state.entities.find((e) => e.id === 'mover')?.pos).toEqual({
      x: 3,
      y: 0,
    });
    expect(resumed.movementEnd).toBe('blocked');
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
  test('the last queued OA after a lethal OA ends the movement exactly once', () => {
    const s = state();
    s.entities = [
      { ...s.entities[0]!, hp: 1 },
      s.entities[1]!,
      {
        id: 'orc2',
        team: 'foes',
        pos: { x: 0, y: 1 },
        size: 1,
        hp: 10,
      },
    ];
    const paused = moveAlong(s, 'mover', route);
    if (!('ok' in paused)) throw new Error(paused.error);
    const lethal = resolveReaction(
      paused.state,
      paused.pending[0]!.reactionId,
      'take',
    );
    if (!('ok' in lethal)) throw new Error(lethal.error);
    expect(lethal.movementEnd).toBeUndefined();
    const last = resolveReaction(
      lethal.state,
      lethal.pending[0]!.reactionId,
      'take',
    );
    expect('ok' in last && last.movementEnd).toBe('incapacitated');
    expect('ok' in last && last.pending).toHaveLength(0);
  });
  test('resumed movement stops when an OA leaves the mover incapacitated', () => {
    const paused = moveAlong(state(), 'mover', route);
    if (!('ok' in paused)) throw new Error(paused.error);
    const resumed = resolveReaction(
      {
        ...paused.state,
        conditions: { mover: ['stunned'] },
      },
      paused.pending[0]!.reactionId,
      'decline',
    );
    expect('ok' in resumed && resumed.movementEnd).toBe('incapacitated');
    expect(
      'ok' in resumed &&
        resumed.state.entities.find((e) => e.id === 'mover')?.pos,
    ).toEqual({ x: 2, y: 0 });
  });
  test('restrained mover ends a resumed move as blocked', () => {
    const paused = moveAlong(state(), 'mover', route);
    if (!('ok' in paused)) throw new Error(paused.error);
    const resumed = resolveReaction(
      {
        ...paused.state,
        conditions: { mover: ['restrained'] },
      },
      paused.pending[0]!.reactionId,
      'decline',
    );
    expect('ok' in resumed && resumed.movementEnd).toBe('blocked');
    expect(
      'ok' in resumed &&
        resumed.state.entities.find((e) => e.id === 'mover')?.pos,
    ).toEqual({ x: 2, y: 0 });
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
