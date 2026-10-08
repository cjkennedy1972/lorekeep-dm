import { rleEncode, type Battlemap } from '@game/schema';
import { describe, expect, test } from 'vitest';
import {
  moveAlong,
  resolveReaction,
  type MovementCommandState,
} from '../src/map/movement.js';

const map: Battlemap = {
  mapId: 'm',
  w: 6,
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
  ],
  cells: rleEncode(Array(18).fill(0)),
  edges: [],
  features: [],
  markers: [],
  zones: [],
  diagonalRule: '5ft',
};
const oa = {
  seed: 123,
  attackId: 'oa',
  attackBonus: 40,
  damage: '1d8',
  damageType: 'slashing',
  targetAc: 1,
};
const foe = (id: string, y: number, hp: number) => ({
  id,
  team: 'foes',
  pos: { x: 0, y },
  size: 1,
  hp,
  opportunityAttack: oa,
});
const state = (
  mover: { hp: number },
  foes: ReturnType<typeof foe>[],
): MovementCommandState => ({
  map,
  entities: [
    { id: 'mover', team: 'heroes', pos: { x: 1, y: 1 }, size: 1, ...mover },
    ...foes,
  ],
  resources: { mover: { movementLeft: 30 } },
});
const route = [
  { x: 1, y: 1 },
  { x: 2, y: 1 },
  { x: 3, y: 1 },
];

// M2-06 regressions found by the door-rubble scenario.
describe('opportunity attacks and downed creatures', () => {
  test('a second pending opportunity attack is not resolved against a mover already killed by the first', () => {
    const paused = moveAlong(
      state({ hp: 1 }, [foe('a', 0, 10), foe('b', 2, 10)]),
      'mover',
      route,
    );
    if (!('ok' in paused)) throw new Error(paused.error);
    expect(paused.pending).toHaveLength(2);
    const first = resolveReaction(
      paused.state,
      paused.pending[0]!.reactionId,
      'take',
    );
    if (!('ok' in first)) throw new Error(first.error);
    expect(first.events.some((e) => e.type === 'HpChanged')).toBe(true);
    // the mover is dead: whatever the caller does with the leftover prompt, no attack lands on a corpse
    const second = first.pending[0]
      ? resolveReaction(first.state, first.pending[0].reactionId, 'take')
      : first;
    if (!('ok' in second)) throw new Error(second.error);
    const attacks = [
      ...first.events,
      ...(second === first ? [] : second.events),
    ].filter((e) => e.type === 'RollEvent' && e.kind === 'attack');
    expect(attacks).toHaveLength(1);
    expect(second.pending).toHaveLength(0);
  });

  test('a hostile at 0 HP does not get an opportunity attack', () => {
    const res = moveAlong(
      state({ hp: 10 }, [foe('down', 0, 0)]),
      'mover',
      route,
    );
    if (!('ok' in res)) throw new Error(res.error);
    expect(res.events.some((e) => e.type === 'OpportunityTriggered')).toBe(
      false,
    );
  });
});
