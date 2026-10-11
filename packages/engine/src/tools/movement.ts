import { DMToolArgsSchema, type Battlemap, type GridPos } from '@game/schema';
import type { CharacterInput } from '../character/types.js';
import {
  moveAlong,
  resolveReaction,
  type MovementCommandState,
  type MovementCombatant,
} from '../map/movement.js';
import { path } from '../map/path.js';
import { movementBudget } from '../map/reachable.js';
import { suggestAreaTargets, type OptionsState } from '../map/options.js';
import { fail, ok, turnHint } from './result.js';

export type MovementToolState = {
  map?: Battlemap;
  actors: Readonly<Record<string, CharacterInput>>;
  entities?: readonly MovementCombatant[];
  resources?: MovementCommandState['resources'];
  hp?: Record<string, number>;
  conditions?: MovementCommandState['conditions'];
  reactions?: Record<string, boolean>;
  pendingReactions?: MovementCommandState['pendingReactions'];
  turnActorId?: string | null;
  targetOptions?: Readonly<Record<string, GridPos>>;
  optionHandles?: Readonly<
    Record<string, { pos: GridPos; expiresTurn: string; affected: string[] }>
  >;
  turnId?: string;
};
export function executeMoveTo(state: MovementToolState, args: unknown) {
  const parsed = DMToolArgsSchema.move_to.safeParse(args);
  if (!parsed.success)
    return fail(
      'schema-violation',
      parsed.error.issues[0]?.message ?? 'Provide valid movement arguments.',
    );
  const { entityId, targetRef, mode } = parsed.data;
  const entity = state.entities?.find((candidate) => candidate.id === entityId);
  if (!entity && !state.actors[entityId])
    return fail('unknown-entity', 'Choose an entity in the session.');
  if (!entity)
    return fail('unknown-entity', 'Choose an entity placed on the active map.');
  if (!state.map)
    return fail(
      'unreachable',
      'Load an active map before moving to a map reference.',
    );
  const conditions = state.conditions?.[entityId] ?? [];
  if (
    conditions.some(
      (condition) =>
        (typeof condition === 'string' ? condition : condition.id) ===
        'restrained',
    )
  )
    return fail('restrained', 'Remove restrained or choose another action.');
  if (state.turnActorId && state.turnActorId !== entityId)
    return fail('not-actors-turn', turnHint(state.turnActorId));
  const marker = state.map.markers.find(
    (candidate) => candidate.markerId === targetRef,
  );
  const feature = state.map.features.find(
    (candidate) => candidate.featureId === targetRef,
  );
  const destination =
    (state.optionHandles?.[targetRef]?.expiresTurn === state.turnId
      ? state.optionHandles?.[targetRef]?.pos
      : undefined) ??
    state.targetOptions?.[targetRef] ??
    marker?.cell ??
    feature?.cells[0] ??
    state.entities?.find((candidate) => candidate.id === targetRef)?.pos;
  if (!destination)
    return fail(
      'unreachable',
      `No entity, marker, feature, or current option matches ${targetRef}.`,
    );
  let goal = destination;
  const modeTargets = state.entities?.find(
    (candidate) => candidate.id === targetRef,
  );
  if (modeTargets && mode === 'adjacent') {
    const candidates: GridPos[] = [];
    for (
      let y = modeTargets.pos.y - 1;
      y <= modeTargets.pos.y + modeTargets.size;
      y++
    )
      for (
        let x = modeTargets.pos.x - 1;
        x <= modeTargets.pos.x + modeTargets.size;
        x++
      ) {
        if (x < 0 || y < 0 || x >= state.map.w || y >= state.map.h) continue;
        const probe = path(
          {
            map: state.map,
            entities: state.entities!,
            resources: state.resources,
            conditions: state.conditions,
          },
          entityId,
          { x, y },
        );
        if ('path' in probe) candidates.push({ x, y });
      }
    goal =
      candidates.sort(
        (a, b) =>
          Math.abs(a.x - entity.pos.x) +
            Math.abs(a.y - entity.pos.y) -
            (Math.abs(b.x - entity.pos.x) + Math.abs(b.y - entity.pos.y)) ||
          a.y - b.y ||
          a.x - b.x,
      )[0] ?? goal;
  }
  const modeName = 'normal';
  const movementState: MovementCommandState = {
    map: state.map,
    entities: state.entities ?? [],
    resources: state.resources,
    hp: state.hp,
    conditions: state.conditions,
    reactions: state.reactions,
    pendingReactions: state.pendingReactions,
  };
  const budget = movementBudget(movementState, entity);
  if (budget <= 0)
    return fail(
      'insufficient-movement',
      'You have 0 feet remaining; choose an adjacent reachable destination or wait for movement to refresh.',
    );
  const result = path(movementState, entityId, goal);
  if ('error' in result) {
    const code =
      result.reason === 'insufficient_movement'
        ? 'insufficient-movement'
        : 'unreachable';
    return fail(code, result.hint);
  }
  const moved = moveAlong(movementState, entityId, result.path, modeName);
  if ('error' in moved)
    return fail(
      moved.reason === 'insufficient_movement'
        ? 'insufficient-movement'
        : 'unreachable',
      moved.hint,
    );
  return ok(
    { state: moved.state, events: moved.events, pending: moved.pending },
    moved.events.map((event) => event.type),
    moved.pending.length
      ? `Movement paused for ${moved.pending.length} opportunity attack reaction(s).`
      : `${entityId} moved to the selected destination.`,
  );
}
export function resolveMoveReaction(
  state: MovementCommandState,
  reactionId: string,
  choice: 'take' | 'decline',
) {
  return resolveReaction(state, reactionId, choice);
}

export type AreaToolState = OptionsState & {
  actors?: Readonly<Record<string, CharacterInput>>;
  options?: Readonly<
    Record<string, { optionId: string; pos: GridPos; expiresTurn: string }>
  >;
  turnId?: string;
};
export function executeSuggestAreaTarget(state: AreaToolState, args: unknown) {
  const parsed = DMToolArgsSchema.suggest_area_target.safeParse(args);
  if (!parsed.success)
    return fail(
      'schema-violation',
      parsed.error.issues[0]?.message ?? 'Provide valid area-target arguments.',
    );
  const spellId = parsed.data.spellId.replace(/^srd:spell\//, 'spell:');
  if (!state.catalog?.get('spell', spellId))
    return fail('unknown-spell', 'Choose a spell in the loaded catalog.');
  const suggestions = suggestAreaTargets(state, parsed.data.casterId, spellId);
  if ('error' in suggestions)
    return fail(
      suggestions.error === 'Unknown caster.'
        ? 'unknown-entity'
        : 'area-needs-anchor',
      suggestions.hint,
    );
  const focus = parsed.data.focusRef;
  const chosen = suggestions.options
    .filter((option) => {
      if (parsed.data.intent === 'hit-target')
        return option.affected.some((affected) => affected.id === focus);
      if (parsed.data.intent === 'avoid-allies')
        return !option.affected.some(
          (affected) => affected.relation === 'ally',
        );
      if (parsed.data.intent === 'max-enemies') return true;
      return true;
    })
    .sort((a, b) => {
      const enemies = (option: typeof a) =>
        option.affected.filter((item) => item.relation === 'enemy').length;
      return parsed.data.intent === 'max-enemies'
        ? enemies(b) - enemies(a) || a.optionId.localeCompare(b.optionId)
        : a.optionId.localeCompare(b.optionId);
    })
    .slice(0, 4);
  const options = chosen.map((option) => {
    const suffix = option.optionId
      .replace(/[^a-z0-9]/gi, '')
      .slice(-8)
      .toLowerCase()
      .padStart(4, '0');
    const optionId = `opt_${suffix}`;
    return { optionId, anchor: option.anchor, affected: option.affected };
  });
  return ok(
    { options },
    [],
    `${options.length} legal area placements offered.`,
  );
}
