import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Battlemap, GridPos } from '@game/schema';
import { loadCatalog } from '../catalog/load.js';
import { attack } from '../combat/attack.js';
import { castSpell, type SpellEvent } from '../combat/spells.js';
import {
  moveAlong,
  resolveReaction,
  type MovementEvent,
  type MovementCommandState,
} from '../map/movement.js';
import { loadAuthoredMap } from '../map/load.js';
import { seedRng } from '../rng.js';
import { monsterPolicy } from './policy.js';

type Entity = {
  id: string;
  team: string;
  pos: GridPos;
  size: number;
  hp: number;
  maxHp: number;
  ac: number;
  speed: number;
  abilities: Record<string, number>;
  attackBonus: number;
  damage: string;
};
export type ScriptedEvent = Record<string, unknown> & { type: string };
export type ScriptedCombatState = {
  mapId: string;
  entities: Entity[];
  outcome: 'in-progress' | 'CombatEnded';
};
export type ScriptedCombatLog = {
  scenario: string;
  seed: number;
  events: ScriptedEvent[];
  finalState: ScriptedCombatState;
};

const cryptJson = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../maps/crypt-room.json', import.meta.url)),
    'utf8',
  ),
) as unknown;
const validMap = loadAuthoredMap(cryptJson);
if (!validMap.ok)
  throw new Error(
    `Invalid crypt encounter map: ${validMap.errors.map((e) => e.message).join(', ')}`,
  );
const map: Battlemap = validMap.map;
const catalog = loadCatalog();
const zero = { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 };

function append(events: ScriptedEvent[], list: readonly { type: string }[]) {
  events.push(...list.map((event) => structuredClone(event) as ScriptedEvent));
}
function combatMovementState(
  entities: Entity[],
  hp: Record<string, number>,
): MovementCommandState {
  return {
    map,
    entities: entities.map((e) => ({
      ...e,
      team: e.team,
      reaction: true,
      opportunityAttack: {
        seed: 0,
        attackId: 'opportunity',
        attackBonus: e.attackBonus,
        damage: e.damage,
        damageType: 'slashing',
        targetAc: 12,
      },
    })),
    hp,
    resources: Object.fromEntries(
      entities.map((e) => [
        e.id,
        { movementRemaining: e.speed, reaction: true },
      ]),
    ),
    reactions: Object.fromEntries(entities.map((e) => [e.id, true])),
  };
}

/** Execute one deterministic scripted level-1 wizard against two goblin warriors in the authored crypt. */
export function runCryptScenario(seed = 2901): ScriptedCombatLog {
  seedRng(seed);
  let rng = seed;
  const entities: Entity[] = [
    {
      id: 'pc-aria',
      team: 'pc',
      pos: { x: 9, y: 4 },
      size: 1,
      hp: 10,
      maxHp: 10,
      ac: 12,
      speed: 30,
      abilities: { ...zero, int: 16, dex: 14, con: 14 },
      attackBonus: 4,
      damage: '1d6+2',
    },
    {
      id: 'goblin-1',
      team: 'goblin',
      pos: { x: 8, y: 4 },
      size: 1,
      hp: 4,
      maxHp: 4,
      ac: 15,
      speed: 30,
      abilities: { ...zero, dex: 15 },
      attackBonus: 4,
      damage: '1d6+2',
    },
    {
      id: 'goblin-2',
      team: 'goblin',
      pos: { x: 10, y: 4 },
      size: 1,
      hp: 4,
      maxHp: 4,
      ac: 15,
      speed: 30,
      abilities: { ...zero, dex: 15 },
      attackBonus: 4,
      damage: '1d6+2',
    },
  ];
  const state: ScriptedCombatState = {
    mapId: map.mapId,
    entities,
    outcome: 'in-progress',
  };
  const events: ScriptedEvent[] = [
    {
      type: 'CombatStarted',
      combatants: entities.map(({ id, speed }) => ({ id, speed })),
    },
  ];
  // Scripted PC moves out of both goblins' reach; resolve the resulting OA deterministically.
  let movement = moveAlong(
    combatMovementState(
      entities,
      Object.fromEntries(entities.map((e) => [e.id, e.hp])),
    ),
    'pc-aria',
    [
      { x: 9, y: 4 },
      { x: 9, y: 3 },
      { x: 9, y: 2 },
    ],
  );
  if ('error' in movement) throw new Error(movement.error);
  append(events, movement.events);
  while (movement.pending.length) {
    const pending = movement.pending[0]!;
    const reaction = resolveReaction(
      movement.state,
      pending.reactionId,
      'take',
    );
    if ('error' in reaction) throw new Error(reaction.error);
    append(events, reaction.events);
    movement = {
      ...movement,
      state: reaction.state,
      events: [],
      pending: reaction.pending,
    };
  }
  const pc = entities[0]!;
  pc.pos = movement.state.entities.find((e) => e.id === pc.id)!.pos;
  pc.hp = movement.state.hp?.[pc.id] ?? pc.hp;
  const areaAnchor = { x: 9, y: 2 };
  const spell = castSpell({
    caster: {
      id: pc.id,
      name: 'Aria',
      speciesId: 'species:human',
      classId: 'class:wizard',
      backgroundId: 'background:acolyte',
      level: 1,
      abilities: { ...zero, int: 16, dex: 14, con: 14 },
      proficiencies: { skills: [], saves: ['int', 'wis'], tools: [] },
      equipment: [],
      spellsKnown: ['spell:burning-hands'],
      spellsPrepared: ['spell:burning-hands'],
      slots: { '1': { max: 2, used: 0 } },
      hp: { current: pc.hp, max: pc.maxHp, temp: 0 },
      conditions: [],
    },
    target: { kind: 'anchor', pos: areaAnchor },
    spellId: 'spell:burning-hands',
    slotLevel: 1,
    seed: rng,
    catalog,
    map: {
      map,
      caster: { pos: pc.pos, size: 1 },
      entities: entities.map((e) => ({
        id: e.id,
        pos: e.pos,
        size: e.size,
        team: e.team,
      })),
      targets: entities.map((e) => ({
        id: e.id,
        hp: e.hp,
        maxHp: e.maxHp,
        ac: e.ac,
        abilities: e.abilities as never,
      })),
      direction: { x: 0, y: 1 },
    },
  });
  if ('error' in spell) throw new Error(spell.error);
  append(events, spell.events as SpellEvent[]);
  rng = spell.rng;
  for (const e of spell.events)
    if (e.type === 'HpChanged') {
      const target = entities.find((entity) => entity.id === e.entityId);
      if (target) target.hp = e.to;
    }
  // The deterministic monster policy is exercised even when opponents are too distant for an action.
  const monsters = entities.filter((e) => e.team !== 'pc' && e.hp > 0);
  for (const monster of monsters) {
    const decision = monsterPolicy({ map, entities, monsterId: monster.id });
    if (decision.kind === 'attack') {
      const target = entities.find((e) => e.id === decision.targetId)!;
      const result = attack({
        attackerId: monster.id,
        targetId: target.id,
        attackId: 'scimitar',
        seed: rng,
        attackBonus: monster.attackBonus,
        damage: monster.damage,
        damageType: 'slashing',
        targetAc: target.ac,
        target: { hp: target.hp, kind: 'pc' },
      });
      if ('error' in result) throw new Error(result.error);
      rng = result.rng;
      append(events, result.events);
      for (const event of result.events)
        if (event.type === 'HpChanged') target.hp = event.to;
    } else if (decision.kind === 'approach' || decision.kind === 'flee') {
      const result = moveAlong(
        combatMovementState(
          entities,
          Object.fromEntries(entities.map((e) => [e.id, e.hp])),
        ),
        monster.id,
        decision.path,
        decision.kind === 'flee' ? 'forced' : 'normal',
      );
      if (!('error' in result))
        append(events, result.events as MovementEvent[]);
    }
  }
  state.outcome = 'CombatEnded';
  events.push({ type: 'CombatEnded', reason: 'script-complete' });
  const replayed = replayCryptCombat({
    scenario: 'crypt-solo-v1',
    seed,
    events,
    finalState: { ...state, entities: [] },
  });
  return { scenario: 'crypt-solo-v1', seed, events, finalState: replayed };
}

/** Rebuild the observable combat state from the full event log. */
export function replayCryptCombat(
  log: Pick<ScriptedCombatLog, 'events'> & Partial<ScriptedCombatLog>,
): ScriptedCombatState {
  const initial = log.events.find((event) => event.type === 'CombatStarted');
  const combatants = (initial?.combatants ?? []) as {
    id: string;
    speed: number;
  }[];
  const positions: Record<string, GridPos> = {
    'pc-aria': { x: 9, y: 4 },
    'goblin-1': { x: 8, y: 5 },
    'goblin-2': { x: 10, y: 5 },
  };
  const stats: Record<string, Omit<Entity, 'pos'>> = {
    'pc-aria': {
      id: 'pc-aria',
      team: 'pc',
      size: 1,
      hp: 10,
      maxHp: 10,
      ac: 12,
      speed: 30,
      abilities: { ...zero, int: 16, dex: 14, con: 14 },
      attackBonus: 4,
      damage: '1d6+2',
    },
    'goblin-1': {
      id: 'goblin-1',
      team: 'goblin',
      size: 1,
      hp: 4,
      maxHp: 4,
      ac: 15,
      speed: 30,
      abilities: { ...zero, dex: 15 },
      attackBonus: 4,
      damage: '1d6+2',
    },
    'goblin-2': {
      id: 'goblin-2',
      team: 'goblin',
      size: 1,
      hp: 4,
      maxHp: 4,
      ac: 15,
      speed: 30,
      abilities: { ...zero, dex: 15 },
      attackBonus: 4,
      damage: '1d6+2',
    },
  };
  for (const event of log.events) {
    if (event.type === 'EntityMoved') {
      const path = event.path as GridPos[];
      if (path?.length)
        positions[String(event.entityId)] = path[path.length - 1]!;
    }
    if (event.type === 'HpChanged') {
      const entity = stats[String(event.entityId)];
      if (entity) entity.hp = Number(event.to);
    }
  }
  return {
    mapId: map.mapId,
    entities: combatants.map(({ id }) => ({
      ...stats[id]!,
      pos: positions[id]!,
    })),
    outcome: log.events.some((event) => event.type === 'CombatEnded')
      ? 'CombatEnded'
      : 'in-progress',
  };
}
