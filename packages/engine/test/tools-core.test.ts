import { describe, expect, test } from 'vitest';
import type { Ability } from '@game/schema';
import { loadCatalog } from '../src/catalog-node.js';
import type { CharacterInput } from '../src/character/types.js';
import { execute } from '../src/tools/index.js';
import { DMToolErrorCodeSchema, DMToolArgsSchema } from '@game/schema';

const catalog = loadCatalog();
const actor = (id: string): CharacterInput => ({
  id,
  name: id,
  speciesId: 'species:human',
  classId: 'class:wizard',
  backgroundId: 'background:sage',
  level: 2,
  abilities: {
    str: 10,
    dex: 14,
    con: 12,
    int: 16,
    wis: 10,
    cha: 10,
  } satisfies Record<Ability, number>,
  proficiencies: { skills: ['stealth'], saves: ['int', 'wis'], tools: [] },
  equipment: [],
  spellsKnown: [],
  spellsPrepared: [],
  slots: {},
  hp: { current: 10, max: 10, temp: 0 },
  conditions: [],
});
const actors = { ent_hero: actor('ent_hero'), ent_goblin: actor('ent_goblin') };
const state = {
  actors,
  attacks: {
    'srd:attack/shortsword': {
      id: 'srd:attack/shortsword',
      ownerId: 'ent_hero',
      attackBonus: 5,
      damage: '1d6+3',
      damageType: 'piercing',
      targetAc: 10,
      reachFt: 5,
      targetKind: 'monster' as const,
    },
  },
  hp: { ent_hero: 10, ent_goblin: 8 },
  ac: {},
  catalog,
  conditions: {},
  targets: {},
  turnId: 'turn_1',
};
const checkArgs = {
  actorId: 'ent_hero',
  ability: 'dex',
  skill: 'srd:skill/stealth',
  dc: 15,
  dcReason: 'quietly cross the hall',
  advantage: 'normal',
};
const success = <T>(result: { ok: boolean; value?: T }): T => {
  if (!result.ok) throw new Error('expected successful tool');
  return result.value as T;
};
const error = (result: { ok: boolean; error?: string }): string => {
  expect(result.ok).toBe(false);
  return result.error!;
};

describe('M2-10 tool executors', () => {
  test('check and save roll in engine from seed, preserve breakdown and DC reason', () => {
    const result = success(
      execute(state, { name: 'request_check', args: checkArgs }, 83) as never,
    ) as {
      result: { total: number; dcReason: string; breakdown: unknown };
      rng: number;
    };
    expect(result.result.dcReason).toBe(checkArgs.dcReason);
    expect(result.result.breakdown).toBeDefined();
    expect(
      execute(state, { name: 'request_check', args: checkArgs }, 83),
    ).toEqual(execute(state, { name: 'request_check', args: checkArgs }, 83));
    expect(
      success(
        execute(
          state,
          {
            name: 'request_save',
            args: {
              actorId: 'ent_hero',
              ability: 'wis',
              dc: 12,
              source: 'poison cloud',
            },
          },
          83,
        ) as never,
      ),
    ).toBeDefined();
  });
  test('closed errors cover malformed arguments, unknown refs, unknown skills, policy DC, and unknown tools without mutation', () => {
    const before = {
      actors: JSON.stringify(state.actors),
      hp: JSON.stringify(state.hp),
      conditions: JSON.stringify(state.conditions),
    };
    const calls = [
      [
        { name: 'request_check', args: { ...checkArgs, actorId: 'bad' } },
        'malformed-ref',
      ],
      [
        {
          name: 'request_check',
          args: { ...checkArgs, actorId: 'ent_missing' },
        },
        'unknown-entity',
      ],
      [
        {
          name: 'request_check',
          args: { ...checkArgs, skill: 'srd:skill/imaginary' },
        },
        'unknown-skill',
      ],
      [
        {
          name: 'request_save',
          args: { actorId: 'ent_hero', ability: 'wis', dc: 31, source: 'trap' },
        },
        'dc-out-of-range',
      ],
      [{ name: 'mystery', args: {} }, 'unknown-tool'],
      [{ name: 'request_check' }, 'missing-argument'],
    ] as const;
    for (const [call, expected] of calls)
      expect(error(execute(state, call, 22)).toString()).toBe(expected);
    expect({
      actors: JSON.stringify(state.actors),
      hp: JSON.stringify(state.hp),
      conditions: JSON.stringify(state.conditions),
    }).toEqual(before);
  });
  test('attacks resolve damage by seeded engine rolls and reject bad targets and illegal attacks', () => {
    const call = {
      name: 'attack',
      args: {
        attackerId: 'ent_hero',
        targetId: 'ent_goblin',
        attackId: 'srd:attack/shortsword',
      },
    };
    const result = success(execute(state, call, 42) as never) as {
      events: { type: string }[];
      rng: number;
    };
    expect(result.events[0]?.type).toBe('RollEvent');
    expect(execute(state, call, 42)).toEqual(execute(state, call, 42));
    expect(
      error(
        execute(
          state,
          { name: 'attack', args: { ...call.args, targetId: 'ent_absent' } },
          1,
        ),
      ).toString(),
    ).toBe('unknown-entity');
    expect(
      error(
        execute(
          state,
          {
            name: 'attack',
            args: { ...call.args, attackId: 'srd:attack/nope' },
          },
          1,
        ),
      ).toString(),
    ).toBe('not-equipped');
  });
  test('spells use caster preparation, engine target state, and seeded rolls', () => {
    const caster = {
      ...actors.ent_hero!,
      spellsKnown: ['spell:fire-bolt'],
      spellsPrepared: ['spell:fire-bolt'],
    };
    const spellState = {
      ...state,
      actors: { ...actors, ent_hero: caster },
      targets: {
        ent_hero: {
          id: 'ent_hero',
          hp: 10,
          maxHp: 10,
          abilities: caster.abilities,
        },
        ent_goblin: {
          id: 'ent_goblin',
          hp: 8,
          maxHp: 8,
          ac: 10,
          abilities: actors.ent_goblin!.abilities,
        },
      },
    };
    const call = {
      name: 'cast_spell',
      args: {
        casterId: 'ent_hero',
        spellId: 'srd:spell/fire-bolt',
        slotLevel: 0,
        target: { kind: 'entity', ref: 'ent_goblin' },
      },
    };
    const one = success(execute(spellState, call, 42) as never) as {
      events: { type: string }[];
      rng: number;
    };
    expect(one.events.some((event) => event.type === 'RollEvent')).toBe(true);
    expect(execute(spellState, call, 42)).toEqual(
      execute(spellState, call, 42),
    );
    expect(
      error(
        execute(
          spellState,
          {
            name: 'cast_spell',
            args: { ...call.args, spellId: 'srd:spell/missing' },
          },
          42,
        ),
      ),
    ).toBe('unknown-spell');
  });
  test('conditions validate engine ownership, duplicates and missing entities; coordinates stay rejected', () => {
    const call = (conditionId: string) => ({
      name: 'apply_condition',
      args: {
        targetId: 'ent_goblin',
        conditionId: `srd:condition/${conditionId}`,
        source: 'spell effect',
        duration: '1-minute',
      },
    });
    expect(success(execute(state, call('prone'), 1) as never)).toBeDefined();
    expect(error(execute(state, call('unconscious'), 1)).toString()).toBe(
      'condition-engine-owned',
    );
    expect(
      error(
        execute(
          { ...state, conditions: { ent_goblin: [{ id: 'prone' }] } },
          call('prone'),
          1,
        ),
      ).toString(),
    ).toBe('already-applied');
    expect(
      error(
        execute(
          state,
          { name: 'apply_condition', args: { ...call('prone').args, x: 3 } },
          1,
        ),
      ).toString(),
    ).toBe('schema-violation');
  });
  test('the executor accepts only closed error codes; schemas reject dice, HP edits, and coordinates', () => {
    expect(DMToolErrorCodeSchema.safeParse('unknown-entity').success).toBe(
      true,
    );
    expect(DMToolErrorCodeSchema.safeParse('invented-error').success).toBe(
      false,
    );
    expect(
      DMToolArgsSchema.attack.safeParse({
        attackerId: 'ent_hero',
        targetId: 'ent_goblin',
        attackId: 'srd:attack/sword',
        damage: '99d99',
        hp: 999,
        x: 1,
      }).success,
    ).toBe(false);
  });
});
