import {
  affectedEntities,
  areaCells,
  castSpell,
  hasLineOfSight,
  distance,
  type AreaShape,
  type Catalog,
  type CharacterInput,
} from '@game/rules-engine';
import type { CombatCommand, GridPos } from '@game/schema';
import type {
  CombatCommandError,
  CombatTransition,
  RoomCombatState,
} from './combatTypes.js';
import { settle } from './combatEngine.js';

type Ev = Record<string, unknown>;
type CastCommand = Extract<CombatCommand['payload'], { command: 'cast' }>;
const DIRECTIONS: GridPos[] = [
  { x: 0, y: -1 },
  { x: 1, y: -1 },
  { x: 1, y: 0 },
  { x: 1, y: 1 },
  { x: 0, y: 1 },
  { x: -1, y: 1 },
  { x: -1, y: 0 },
  { x: -1, y: -1 },
];
const catalogSpellId = (id: string) => id.replace(/^srd:spell\//, 'spell:');
const reject = (message: string): CombatCommandError => ({
  code: 'COMMAND_REJECTED',
  message,
});

export type AreaOption = {
  optionId: string;
  anchor: GridPos;
  direction: GridPos;
  cells: GridPos[];
  affected: { id: string; relation: 'ally' | 'enemy' }[];
};

/** Every legal aim of an area spell, computed by the engine from the map; the client picks one by optionId. */
export function areaOptions(
  state: RoomCombatState,
  casterId: string,
  spellId: string,
  catalog: Catalog,
): AreaOption[] {
  const caster = state.entities.find((e) => e.id === casterId);
  const spell = catalog.get('spell', catalogSpellId(spellId));
  const template = spell?.template;
  if (!caster || !spell || !template) return [];
  const shape = template.shape as AreaShape;
  const spec = {
    shape,
    size: template.size,
    width: template.width,
    height: template.height,
  };
  const selfOrigin =
    spell.range?.kind === 'self' || shape === 'cone' || shape === 'line';
  const aims: { anchor: GridPos; direction: GridPos }[] = [];
  if (selfOrigin) {
    for (const direction of DIRECTIONS)
      aims.push({ anchor: caster.pos, direction });
  } else {
    const reach = spell.range?.kind === 'feet' ? spell.range.feet : Infinity;
    for (const entity of state.entities) {
      if (entity.hp <= 0 || entity.fled) continue;
      if (distance(caster, entity, state.map.diagonalRule) > reach) continue;
      if (!hasLineOfSight(state.map, caster, entity)) continue;
      aims.push({
        anchor: entity.pos,
        direction: {
          x: Math.sign(entity.pos.x - caster.pos.x),
          y: Math.sign(entity.pos.y - caster.pos.y) || 1,
        },
      });
    }
  }
  const placed = state.entities
    .filter((e) => e.hp > 0 && !e.fled)
    .map((e) => ({ id: e.id, pos: e.pos, size: e.size }));
  return aims.map(({ anchor, direction }) => {
    const cells = areaCells(state.map, spec, anchor, direction);
    const affected = affectedEntities(
      cells,
      { map: state.map, entities: placed },
      anchor,
    )
      .filter(({ id }) => !(shape === 'cone' && id === casterId))
      .map(({ id }) => ({
        id,
        relation:
          state.entities.find((e) => e.id === id)?.team === caster.team
            ? ('ally' as const)
            : ('enemy' as const),
      }));
    return {
      optionId: `area:${catalogSpellId(spellId)}:${anchor.x},${anchor.y}:${direction.x},${direction.y}`,
      anchor,
      direction,
      cells,
      affected,
    };
  });
}

/** A spell as a player command: single targets and area aims are both resolved by the engine's castSpell. */
export function castCommand(
  state: RoomCombatState,
  actorId: string,
  command: CastCommand,
  character: CharacterInput | undefined,
  catalog: Catalog,
): CombatTransition | CombatCommandError {
  const caster = state.entities.find((e) => e.id === actorId);
  const resources = state.combat.resources[actorId];
  if (!caster || !character || !resources?.action)
    return reject('You cannot cast a spell right now.');
  const spellId = catalogSpellId(command.spellId);
  if (
    !character.spellsKnown.includes(spellId) &&
    !character.spellsPrepared.includes(spellId)
  )
    return reject('Your character does not have that spell prepared.');
  const entry = catalog.get('spell', spellId);
  if (!entry) return reject('That spell is not in the rules catalog.');
  const target = command.target;
  const targetEntity =
    target.kind === 'entity'
      ? state.entities.find((e) => e.id === target.ref)
      : target.kind === 'self'
        ? caster
        : undefined;
  let aim: { anchor: GridPos; direction: GridPos } | undefined;
  if (target.kind === 'option' || target.kind === 'anchor') {
    const options = areaOptions(state, actorId, spellId, catalog);
    const picked = options.find((option) =>
      target.kind === 'option'
        ? option.optionId === target.ref
        : `${option.anchor.x},${option.anchor.y}` === target.ref,
    );
    if (!picked) return reject('That is not a legal way to aim this spell.');
    aim = picked;
  } else if (!targetEntity) return reject('That target is not on the map.');
  const sheet = (e: (typeof state.entities)[number]) => ({
    id: e.id,
    hp: e.hp,
    maxHp: e.maxHp,
    ac: e.ac,
    abilities: e.abilities ?? {
      str: 10,
      dex: 10,
      con: 10,
      int: 10,
      wis: 10,
      cha: 10,
    },
  });
  const result = castSpell({
    caster: { ...character, id: actorId },
    target: aim ? { kind: 'option', pos: aim.anchor } : sheet(targetEntity!),
    spellId,
    slotLevel: command.slotLevel,
    seed: state.seed ?? 1,
    catalog,
    state: {
      concentration: state.concentration ?? {},
      hp: Object.fromEntries(state.entities.map((e) => [e.id, e.hp])),
      slots: {},
    },
    map: {
      map: state.map,
      caster: { pos: caster.pos, size: caster.size },
      entities: state.entities
        .filter((e) => e.hp > 0)
        .map((e) => ({ id: e.id, pos: e.pos, size: e.size })),
      targets: state.entities.map(sheet),
      ...(aim ? { anchor: aim.anchor, direction: aim.direction } : {}),
    },
  });
  if ('error' in result) return reject(result.hint);
  const events = result.events as unknown as Ev[];
  let entities = state.entities;
  for (const event of events)
    if (event.type === 'HpChanged')
      entities = entities.map((e) =>
        e.id === event.entityId ? { ...e, hp: Number(event.to) } : e,
      );
  const next: RoomCombatState = {
    ...state,
    entities,
    seed: result.rng,
    concentration: result.state.concentration,
    combat: {
      ...state.combat,
      resources: {
        ...state.combat.resources,
        [actorId]: { ...resources, action: false },
      },
    },
  };
  const closing = settle(next);
  return {
    state: closing.state,
    events: [
      ...events,
      { type: 'ActionSpent', entityId: actorId },
      ...closing.events,
    ],
    slots: { entityId: actorId, slots: result.state.slots[actorId] ?? {} },
  };
}
