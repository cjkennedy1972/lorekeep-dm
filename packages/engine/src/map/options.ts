import type { Catalog } from '../catalog/types.js';
import type { CharacterInput } from '../character/types.js';
import type { SpellTarget } from '../combat/spells.js';
import type { Battlemap, GridPos } from '@game/schema';
import { areaCells, affectedEntities, type AreaShape } from './area.js';
import { distance, type Placed } from './geometry.js';
import { hasLineOfSight } from './los.js';
import { reachable, type MovementEntity } from './reachable.js';

export type OptionEntity = MovementEntity & {
  name?: string;
  hp?: number;
  maxHp?: number;
  ac?: number;
  abilities?: SpellTarget['abilities'];
  hidden?: boolean;
  visibleTo?: readonly string[];
  attacks?: readonly {
    id: string;
    name: string;
    reachFt?: number;
    range?: { normalFt: number; longFt?: number };
  }[];
};
export type OptionSpell = {
  id: string;
  template?: { shape: AreaShape; size: number; width?: number };
};
export type OptionsState = {
  map: Battlemap;
  entities: readonly OptionEntity[];
  resources?: Readonly<
    Record<
      string,
      {
        action?: boolean;
        bonusAction?: boolean;
        movementLeft?: number;
        movementRemaining?: number;
      }
    >
  >;
  conditions?: Readonly<Record<string, readonly (string | { id: string })[]>>;
  casters?: Readonly<Record<string, CharacterInput>>;
  spells?: readonly OptionSpell[];
  catalog?: Catalog;
  visibility?: Readonly<Record<string, readonly string[]>>;
};
export type LegalAction =
  | {
      kind: 'move';
      optionId: string;
      destination: GridPos;
      cost: number;
      entityId: string;
    }
  | {
      kind: 'attack';
      optionId: string;
      attackerId: string;
      targetId: string;
      attackId: string;
    }
  | {
      kind: 'spell';
      optionId: string;
      casterId: string;
      spellId: string;
      targetId: string;
    }
  | { kind: 'end-turn'; optionId: string; entityId: string };
export type ResolvedAction =
  | { kind: 'move'; entityId: string; destination: GridPos }
  | { kind: 'attack'; attackerId: string; targetId: string; attackId: string }
  | { kind: 'spell'; casterId: string; spellId: string; targetId: string }
  | { kind: 'end-turn'; entityId: string };
export type OptionError = { error: string; hint: string };
export type LegalOptionsResult = { actions: LegalAction[] } | OptionError;
export type AreaTargetSuggestion = {
  optionId: string;
  anchor: GridPos;
  affected: {
    id: string;
    name: string;
    relation: 'ally' | 'enemy' | 'unknown';
  }[];
};
export type AreaSuggestionResult =
  | { options: AreaTargetSuggestion[] }
  | OptionError;
const fail = (error: string, hint: string): OptionError => ({ error, hint });
const idOf = (prefix: string, value: unknown) =>
  `${prefix}:${JSON.stringify(value)}`;
const visible = (
  state: OptionsState,
  viewer: OptionEntity,
  target: OptionEntity,
) =>
  target.id === viewer.id ||
  (!target.hidden &&
    target.visibleTo?.includes(viewer.id) !== false &&
    (!state.visibility?.[viewer.id] ||
      state.visibility[viewer.id]!.includes(target.id)));
const unconscious = (state: OptionsState, entity: OptionEntity) =>
  entity.hp === 0 ||
  [...(entity.conditions ?? []), ...(state.conditions?.[entity.id] ?? [])].some(
    (c) => (typeof c === 'string' ? c : c.id) === 'unconscious',
  );
const adjacent = (a: Placed, b: Placed, rule: Battlemap['diagonalRule']) =>
  distance(a, b, rule) <= 5;

/** List legal action descriptors for an entity, using engine-issued opaque handles. */
export function legalOptions(
  state: OptionsState,
  entityId: string,
): LegalOptionsResult {
  const entity = state.entities.find((candidate) => candidate.id === entityId);
  if (!entity) return fail('Unknown entity.', 'Choose an entity on the map.');
  if (unconscious(state, entity)) return { actions: [] };
  const actions: LegalAction[] = [];
  const destinations = reachable(
    {
      map: state.map,
      entities: state.entities,
      resources: state.resources,
      conditions: state.conditions,
    },
    entityId,
  );
  if (Array.isArray(destinations))
    for (const dest of destinations) {
      if (dest.cell.x === entity.pos.x && dest.cell.y === entity.pos.y)
        continue;
      actions.push({
        kind: 'move',
        optionId: idOf('move', [entityId, dest.cell, dest.cost]),
        entityId,
        destination: dest.cell,
        cost: dest.cost,
      });
    }
  for (const target of state.entities) {
    if (
      target.id === entity.id ||
      unconscious(state, target) ||
      !visible(state, entity, target)
    )
      continue;
    for (const attack of entity.attacks ?? []) {
      const range = attack.range;
      if (
        range
          ? distance(entity, target, state.map.diagonalRule) <=
            (range.longFt ?? range.normalFt)
          : adjacent(entity, target, state.map.diagonalRule)
      )
        actions.push({
          kind: 'attack',
          optionId: idOf('attack', [entityId, target.id, attack.id]),
          attackerId: entityId,
          targetId: target.id,
          attackId: attack.id,
        });
    }
    const caster = state.casters?.[entityId];
    if (caster && state.catalog)
      for (const spell of state.spells ?? []) {
        const entry = state.catalog.get('spell', spell.id);
        if (
          !entry ||
          !target.abilities ||
          target.hp === undefined ||
          !entry.resolution ||
          entry.resolution.kind === 'utility'
        )
          continue;
        if (
          entry.range?.kind === 'feet' &&
          distance(entity, target, state.map.diagonalRule) > entry.range.feet
        )
          continue;
        if (!hasLineOfSight(state.map, entity, target)) continue;
        const slotLevel = entry.level;
        if (
          entry.level > 0 &&
          (!caster.slots[String(slotLevel)] ||
            caster.slots[String(slotLevel)]!.used >=
              caster.slots[String(slotLevel)]!.max)
        )
          continue;
        actions.push({
          kind: 'spell',
          optionId: idOf('spell', [entityId, target.id, spell.id]),
          casterId: entityId,
          targetId: target.id,
          spellId: spell.id,
        });
      }
  }
  actions.push({
    kind: 'end-turn',
    optionId: idOf('end-turn', entityId),
    entityId,
  });
  return { actions };
}

/** Resolve only a currently-listed handle; any state change invalidates it. */
export function resolveOption(
  state: OptionsState,
  entityId: string,
  optionId: string,
): ResolvedAction | OptionError {
  const result = legalOptions(state, entityId);
  if ('error' in result) return result;
  const action = result.actions.find(
    (candidate) => candidate.optionId === optionId,
  );
  if (!action)
    return fail(
      'Unknown or stale optionId.',
      'Request legal options again and choose a current optionId.',
    );
  switch (action.kind) {
    case 'move':
      return {
        kind: action.kind,
        entityId: action.entityId,
        destination: action.destination,
      };
    case 'attack':
      return {
        kind: action.kind,
        attackerId: action.attackerId,
        targetId: action.targetId,
        attackId: action.attackId,
      };
    case 'spell':
      return {
        kind: action.kind,
        casterId: action.casterId,
        targetId: action.targetId,
        spellId: action.spellId,
      };
    case 'end-turn':
      return { kind: action.kind, entityId: action.entityId };
  }
}

/** Suggest legal area-spell anchors with affected-entity previews, without coordinate input. */
export function suggestAreaTargets(
  state: OptionsState,
  casterId: string,
  spellId: string,
): AreaSuggestionResult {
  const caster = state.entities.find((entity) => entity.id === casterId);
  if (!caster) return fail('Unknown caster.', 'Choose a caster on the map.');
  const spell = state.spells?.find((candidate) => candidate.id === spellId);
  if (!spell?.template)
    return fail(
      'Spell has no area template.',
      'Choose an area spell with a supported template.',
    );
  if (!state.catalog?.get('spell', spellId))
    return fail('Unknown spell.', 'Choose a spell in the loaded catalog.');
  const anchors = new Map<string, GridPos>();
  for (const target of state.entities)
    if (visible(state, caster, target) && !unconscious(state, target))
      anchors.set(`${target.pos.x},${target.pos.y}`, target.pos);
  anchors.set(`${caster.pos.x},${caster.pos.y}`, caster.pos);
  const options = [...anchors.values()]
    .sort((a, b) => a.y - b.y || a.x - b.x)
    .map((anchor) => {
      const cells = areaCells(state.map, { ...spell.template! }, anchor);
      const affected = affectedEntities(
        cells,
        { map: state.map, entities: state.entities },
        anchor,
      )
        .filter(({ id }) => {
          const target = state.entities.find((e) => e.id === id)!;
          return visible(state, caster, target);
        })
        .map(({ id }) => {
          const target = state.entities.find((e) => e.id === id)!;
          return {
            id,
            name: target.name ?? id,
            relation:
              target.team === caster.team
                ? ('ally' as const)
                : target.team === undefined || caster.team === undefined
                  ? ('unknown' as const)
                  : ('enemy' as const),
          };
        });
      return {
        optionId: idOf('area', [
          casterId,
          spellId,
          anchor,
          affected.map((e) => e.id),
        ]),
        anchor,
        affected,
      };
    });
  return { options };
}
