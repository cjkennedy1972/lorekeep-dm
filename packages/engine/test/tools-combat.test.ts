import { describe, expect, test } from 'vitest';
import type { Battlemap } from '@game/schema';
import { loadCatalog } from '../src/catalog-node.js';
import type { CharacterInput } from '../src/character/types.js';
import { seedRng } from '../src/rng.js';
import { executeEndCombat, executeStartCombat } from '../src/tools/combat.js';
import {
  executeMoveTo,
  executeSuggestAreaTarget,
} from '../src/tools/movement.js';
import { resolveReaction } from '../src/map/movement.js';
import { emptyCombatState } from '../src/combat/state.js';
import { rleEncode } from '@game/schema';

const catalog = loadCatalog();
const hero: CharacterInput = {
  id: 'ent_hero',
  name: 'Hero',
  speciesId: 'species:human',
  classId: 'class:wizard',
  backgroundId: 'background:sage',
  level: 1,
  abilities: { str: 10, dex: 16, con: 12, int: 14, wis: 10, cha: 10 },
  proficiencies: { skills: [], saves: ['int', 'wis'], tools: [] },
  equipment: [],
  spellsKnown: ['spell:burning-hands'],
  spellsPrepared: ['spell:burning-hands'],
  slots: {},
  hp: { current: 10, max: 10, temp: 0 },
  conditions: [],
};
const blankMap = (): Battlemap => ({
  mapId: 'test',
  w: 10,
  h: 10,
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
  cells: rleEncode(Array(100).fill(0)),
  edges: [],
  features: [],
  markers: [{ markerId: 'mk_goal', cell: { x: 2, y: 2 }, label: 'goal' }],
  zones: [
    {
      zoneId: 'zone_party',
      kind: 'spawn',
      cells: [
        { x: 1, y: 1 },
        { x: 2, y: 1 },
      ],
    },
    {
      zoneId: 'zone_enemy',
      kind: 'spawn',
      cells: [
        { x: 7, y: 7 },
        { x: 8, y: 7 },
      ],
    },
  ],
  diagonalRule: '5ft',
});
const state = () => ({
  actors: { [hero.id]: hero },
  catalog,
  map: blankMap(),
  entities: [
    {
      id: hero.id,
      name: hero.name,
      team: 'party',
      pos: { x: 4, y: 5 },
      size: 1,
      hp: 10,
      maxHp: 10,
      ac: 12,
      speed: 30,
      dexterity: 16,
      initiativeModifier: 3,
    },
  ],
  combat: emptyCombatState(),
});
const good = <T>(r: { ok: boolean; value?: T }): T => {
  if (!r.ok) throw new Error('expected success');
  return r.value as T;
};
const err = (r: { ok: boolean; error?: string }) => {
  expect(r.ok).toBe(false);
  return r.error;
};

describe('M2-11 combat/movement tools', () => {
  test('start encounter uses catalog, authored spawn cells and seeded engine initiative; over budget warns', () => {
    const base = state();
    const args = {
      enemies: [{ monsterId: 'srd:monster/goblin-warrior', count: 1 }],
    };
    const rawFirst = executeStartCombat(base, args, seedRng(77));
    if (!rawFirst.ok) throw new Error(`${rawFirst.error}: ${rawFirst.hint}`);
    const first = rawFirst.value;
    expect(first.entities).toHaveLength(2);
    expect(first.combat.initiative).toHaveLength(2);
    expect(first.warnings).toBeDefined();
    expect(executeStartCombat(base, args, seedRng(77))).toEqual(
      executeStartCombat(base, args, seedRng(77)),
    );
    expect(
      err(
        executeStartCombat(
          base,
          { enemies: [{ monsterId: 'srd:monster/not-real', count: 1 }] },
          3,
        ),
      ),
    ).toBe('unknown-monster');
    expect(
      err(
        executeStartCombat(
          base,
          {
            enemies: [
              {
                monsterId: 'srd:monster/goblin-warrior',
                count: 1,
                spawnRef: 'mk_missing',
              },
            ],
          },
          3,
        ),
      ),
    ).toBe('no-spawn-space');
    expect(
      err(executeStartCombat({ ...base, combat: first.combat }, args, 3)),
    ).toBe('already-in-combat');
    expect(err(executeStartCombat(base, { enemies: [] }, 3))).toBe(
      'schema-violation',
    );
    expect(base.entities?.[0]?.pos).toEqual({ x: 4, y: 5 });
  });
  test('end encounter rejects active enemies and awards CR XP to party', () => {
    const base = state();
    const rawStarted = executeStartCombat(
      base,
      { enemies: [{ monsterId: 'srd:monster/goblin-warrior', count: 1 }] },
      15,
    );
    if (!rawStarted.ok)
      throw new Error(`${rawStarted.error}: ${rawStarted.hint}`);
    const started = rawStarted.value;
    expect(
      err(
        executeEndCombat({ ...base, ...started }, { outcome: 'party-victory' }),
      ),
    ).toBe('enemies-still-active');
    const dead = started.entities.map((entity) =>
      entity.team === 'enemies' ? { ...entity, hp: 0 } : entity,
    );
    const ended = good(
      executeEndCombat(
        { ...base, ...started, entities: dead },
        { outcome: 'party-victory' },
      ),
    );
    expect(ended.xp[hero.id]).toBe(50);
    expect(err(executeEndCombat(base, { outcome: 'truce' }))).toBe(
      'not-in-combat',
    );
  });
  test('move_to uses references and engine path; opportunity attacks suspend movement and resolve', () => {
    const base = state();
    const entities = [
      {
        id: 'ent_hero',
        team: 'party',
        pos: { x: 4, y: 5 },
        size: 1,
        hp: 10,
        speed: 30,
      },
      {
        id: 'ent_guard',
        team: 'enemy',
        pos: { x: 5, y: 5 },
        size: 1,
        hp: 8,
        speed: 30,
        reaction: true,
        opportunityAttack: {
          seed: 21,
          attackId: 'oa',
          attackBonus: 99,
          damage: '1d6',
          damageType: 'slashing',
          targetAc: 1,
        },
      },
    ];
    const movement = executeMoveTo(
      {
        ...base,
        entities,
        resources: {
          ent_hero: { movementRemaining: 30 },
          ent_guard: { movementRemaining: 30, reaction: true },
        },
      },
      { entityId: 'ent_hero', targetRef: 'mk_goal', mode: 'within' },
    );
    if (!movement.ok) throw new Error(`${movement.error}: ${movement.hint}`);
    const moved = movement.value as {
      state: Parameters<typeof resolveReaction>[0];
      events: { type: string }[];
      pending: { reactionId: string }[];
    };
    expect(
      moved.events.some((event) => event.type === 'OpportunityTriggered'),
    ).toBe(true);
    expect(moved.pending).toHaveLength(1);
    const reacted = resolveReaction(
      moved.state,
      moved.pending[0]!.reactionId,
      'take',
    );
    expect('error' in reacted).toBe(false);
    if (!('error' in reacted))
      expect(reacted.events.some((event) => event.type === 'HpChanged')).toBe(
        true,
      );
    expect(
      err(
        executeMoveTo(
          { ...base, entities },
          { entityId: 'ent_hero', targetRef: 'mk_absent', mode: 'within' },
        ),
      ),
    ).toBe('unreachable');
    expect(
      err(
        executeMoveTo(
          { ...base, entities, combat: { activeEntityId: 'ent_guard' } },
          { entityId: 'ent_hero', targetRef: 'mk_goal', mode: 'within' },
        ),
      ),
    ).toBe('not-actors-turn');
    expect(
      err(
        executeMoveTo(
          {
            ...base,
            entities,
            conditions: { ent_hero: [{ id: 'restrained' }] },
          },
          { entityId: 'ent_hero', targetRef: 'mk_goal', mode: 'within' },
        ),
      ),
    ).toBe('restrained');
    expect(
      err(
        executeMoveTo(
          {
            ...base,
            entities,
            resources: { ent_hero: { movementRemaining: 0 } },
          },
          { entityId: 'ent_hero', targetRef: 'mk_goal', mode: 'within' },
        ),
      ),
    ).toBe('insufficient-movement');
    expect(
      err(
        executeMoveTo(base, {
          entityId: 'ent_hero',
          targetRef: 'mk_goal',
          mode: 'within',
          x: 1,
        }),
      ),
    ).toBe('schema-violation');
  });
  test('area aiming filters the engine legal previews and never accepts coordinates', () => {
    const map = blankMap();
    const caster = {
      id: 'ent_hero',
      name: 'Hero',
      team: 'party',
      pos: { x: 4, y: 4 },
      size: 1,
      hp: 10,
      maxHp: 10,
      abilities: hero.abilities,
    };
    const enemy = {
      id: 'ent_enemy',
      name: 'Enemy',
      team: 'enemy',
      pos: { x: 5, y: 4 },
      size: 1,
      hp: 8,
      maxHp: 8,
      abilities: hero.abilities,
    };
    const ally = {
      ...caster,
      id: 'ent_ally',
      name: 'Ally',
      pos: { x: 4, y: 5 },
    };
    const area = good(
      executeSuggestAreaTarget(
        {
          map,
          entities: [caster, enemy, ally],
          catalog,
          spells: [
            {
              id: 'spell:burning-hands',
              template: { shape: 'cone', size: 15 },
            },
          ],
          casters: { ent_hero: hero },
        },
        {
          spellId: 'srd:spell/burning-hands',
          casterId: 'ent_hero',
          intent: 'avoid-allies',
        },
      ),
    ) as {
      options: {
        optionId: string;
        anchor: { x: number; y: number };
        affected: { id: string }[];
      }[];
    };
    expect(area.options.length).toBeGreaterThan(0);
    expect(
      area.options.every((option) =>
        option.affected.every((target) => target.id !== 'ent_ally'),
      ),
    ).toBe(true);
    expect(area.options[0]?.optionId).toMatch(/^opt_[a-z0-9]{4,8}$/);
    expect(
      err(
        executeSuggestAreaTarget(
          { map, entities: [caster], catalog },
          {
            spellId: 'srd:spell/nope',
            casterId: 'ent_hero',
            intent: 'max-enemies',
            x: 4,
          },
        ),
      ),
    ).toBe('schema-violation');
    expect(
      err(
        executeSuggestAreaTarget(
          { map, entities: [caster], catalog },
          {
            spellId: 'srd:spell/nope',
            casterId: 'ent_hero',
            intent: 'max-enemies',
          },
        ),
      ),
    ).toBe('unknown-spell');
  });
});
