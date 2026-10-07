import { describe, expect, test } from 'vitest';
import {
  abilityCheck,
  contestedCheck,
  deathSave,
  freshDeathSaves,
  savingThrow,
} from '../src/combat/checks.js';
import {
  applyCondition,
  attackRollMode,
  removeCondition,
  replayConditions,
  startTurnWithConditions,
  tickConditions,
  type ConditionEvent,
} from '../src/combat/conditions.js';
import { apply, emptyCombatState, replay } from '../src/combat/state.js';
import { rollInitiative, startCombat } from '../src/combat/commands.js';
import { nextDie } from '../src/rng.js';

const seedWithDie = (pred: (d: number) => boolean) => {
  for (let s = 0; s < 5000; s++) if (pred(nextDie(s, 20)[0])) return s;
  throw new Error('no seed');
};
const P = (
  id:
    | 'prone'
    | 'poisoned'
    | 'stunned'
    | 'unconscious'
    | 'grappled'
    | 'incapacitated',
) => [{ id }];

describe('checks', () => {
  test('check records dcReason and breakdown', () => {
    const [r] = abilityCheck(
      {
        ability: 'dex',
        modifier: 3,
        skill: 'Stealth',
        proficiencyBonus: 2,
        dc: 15,
        dcReason: 'guards alert',
      },
      7,
    );
    if ('error' in r) throw new Error(r.error);
    expect(r.dcReason).toBe('guards alert');
    expect(r.breakdown.modifiers.map((m) => m.value)).toEqual([3, 2]);
    expect(r.total).toBe(r.breakdown.dice[0]!.value + 5);
    expect(r.success).toBe(r.total >= 15);
  });
  test('missing dcReason is rejected', () => {
    const [r] = abilityCheck(
      { ability: 'str', modifier: 0, dc: 10, dcReason: ' ' },
      1,
    );
    expect('error' in r).toBe(true);
  });
  test('poisoned gives disadvantage on checks; stunned auto-fails dex save', () => {
    const [c] = abilityCheck(
      {
        ability: 'str',
        modifier: 0,
        dc: 10,
        dcReason: 'x',
        conditions: P('poisoned'),
      },
      1,
    );
    if ('error' in c) throw new Error(c.error);
    expect(c.mode).toBe('disadvantage');
    const [s] = savingThrow(
      {
        ability: 'dex',
        modifier: 20,
        dc: 5,
        dcReason: 'trap',
        conditions: P('stunned'),
      },
      1,
    );
    if ('error' in s) throw new Error(s.error);
    expect(s.success).toBe(false);
  });
  test('contested check picks higher total', () => {
    const [r] = contestedCheck(
      { ability: 'str', modifier: 20 },
      { ability: 'str', modifier: -20 },
      3,
    );
    if ('error' in r) throw new Error(r.error);
    expect(r.winner).toBe('a');
  });
});

describe('conditions', () => {
  test.each([
    ['prone target, adjacent', [], P('prone'), 5, 'advantage'],
    ['prone target, ranged', [], P('prone'), 30, 'disadvantage'],
    ['prone attacker', P('prone'), [], 5, 'disadvantage'],
    [
      'prone target + poisoned attacker adjacent cancels',
      P('poisoned'),
      P('prone'),
      5,
      'normal',
    ],
    [
      'unconscious target implies prone/adv',
      [],
      P('unconscious'),
      5,
      'advantage',
    ],
    ['no conditions', [], [], 5, 'normal'],
  ] as const)('%s', (_n, a, t, d, expected) => {
    expect(attackRollMode(a, t, d)).toBe(expected);
  });

  test('apply, tick duration, remove', () => {
    const ap = applyCondition('a', { id: 'prone', durationRounds: 2 });
    if (!('ok' in ap)) throw new Error(ap.error);
    let st = replayConditions({}, ap.events);
    st = replayConditions(st, [tickConditions('a')]);
    expect(st.a![0]!.durationRounds).toBe(1);
    st = replayConditions(st, [tickConditions('a')]);
    expect(st.a).toEqual([]);
    expect('error' in removeCondition(st, 'a', 'prone')).toBe(true);
  });

  test('stunned skips action resources with reason; grappled zeroes movement', () => {
    const started = startCombat(emptyCombatState(), [
      { id: 'a', initiativeModifier: 1, speed: 30 },
      { id: 'b', initiativeModifier: 0, speed: 30 },
    ]);
    if (!('ok' in started)) throw new Error(started.error);
    let s = replay(emptyCombatState(), started.events);
    const r = rollInitiative(s, 9);
    if (!('ok' in r)) throw new Error(r.error);
    s = replay(s, r.events);
    const first = s.initiative[0]!.entityId;
    const ev: ConditionEvent[] = [
      {
        type: 'ConditionApplied',
        entityId: first,
        condition: { id: 'stunned' },
      },
    ];
    const turn = startTurnWithConditions(s, replayConditions({}, ev), first);
    if (!('ok' in turn)) throw new Error(turn.error);
    const skipped = turn.events.find((e) => e.type === 'ActionsSkipped');
    expect(skipped).toMatchObject({
      reason: expect.stringContaining('stunned'),
    });
    const after = turn.events.reduce(
      (st, e) =>
        'type' in e &&
        [
          'TurnStarted',
          'ActionSpent',
          'BonusActionSpent',
          'ReactionSpent',
          'MovementSpent',
        ].includes(e.type)
          ? apply(st, e as never)
          : st,
      s,
    );
    expect(after.resources[first]).toEqual({
      action: false,
      bonusAction: false,
      reaction: false,
      movementRemaining: 0,
    });
    const g = startTurnWithConditions(
      s,
      { [first]: [{ id: 'grappled' }] },
      first,
    );
    if (!('ok' in g)) throw new Error(g.error);
    expect(g.events.some((e) => e.type === 'ActionsSkipped')).toBe(false);
    expect(g.events.some((e) => e.type === 'MovementSpent')).toBe(true);
  });
});

describe('death saves', () => {
  const run = (pred: (d: number) => boolean, n: number) => {
    let st = freshDeathSaves();
    for (let i = 0; i < n; i++) {
      const [r] = deathSave(st, seedWithDie(pred));
      if ('error' in r) throw new Error(r.error);
      st = r.state;
    }
    return st;
  };
  test('three failures => dead', () =>
    expect(run((d) => d > 1 && d < 10, 3).dead).toBe(true));
  test('three successes => stable', () => {
    const st = run((d) => d >= 10 && d < 20, 3);
    expect(st.stable).toBe(true);
    expect(st.dead).toBe(false);
  });
  test('natural 20 restores 1 HP and resets', () => {
    const [r] = deathSave(
      { ...freshDeathSaves(), failures: 2 },
      seedWithDie((d) => d === 20),
    );
    if ('error' in r) throw new Error(r.error);
    expect(r.state).toEqual({
      successes: 0,
      failures: 0,
      stable: false,
      dead: false,
      hp: 1,
    });
  });
  test('natural 1 counts two failures', () => {
    const [r] = deathSave(
      freshDeathSaves(),
      seedWithDie((d) => d === 1),
    );
    if ('error' in r) throw new Error(r.error);
    expect(r.state.failures).toBe(2);
  });
});
