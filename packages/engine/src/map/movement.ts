import type { GridPos } from '@game/schema';
import {
  attack,
  type AttackInput,
  type AttackEvent,
} from '../combat/attack.js';
import {
  effectiveConditions,
  type ActiveCondition,
  type ConditionId,
} from '../combat/conditions.js';
import { cellKey, inReach } from './geometry.js';
import {
  movementBudget,
  movementCost,
  movementNeighbors,
  type MovementState,
} from './reachable.js';
import type { ThreatEntity } from './threat.js';

export type MovementCombatant = ThreatEntity & {
  hp: number;
  kind?: 'pc' | 'monster';
  ac?: number;
  opportunityAttack?: Omit<AttackInput, 'attackerId' | 'targetId' | 'target'>;
  reaction?: boolean;
  reachFt?: number;
};
export type MovementMode = 'normal' | 'disengage' | 'forced';
export type MovementEvent =
  | { type: 'MovementSpent'; entityId: string; feet: number }
  | { type: 'EntityMoved'; entityId: string; path: GridPos[]; cost: number }
  | { type: 'OpportunityTriggered'; moverId: string; attackerId: string }
  | {
      type: 'ReactionAvailable';
      entityId: string;
      trigger: 'opportunityAttack';
    }
  | {
      type: 'ReactionResolved';
      entityId: string;
      used: boolean;
      reactionId: string;
    }
  | { type: 'ReactionSpent'; entityId: string }
  | AttackEvent;
export type PendingReaction = {
  reactionId: string;
  moverId: string;
  hostileId: string;
  remainingPath: GridPos[];
  mode: MovementMode;
};
export type MovementCommandState = Omit<
  MovementState,
  'entities' | 'resources'
> & {
  entities: readonly MovementCombatant[];
  resources?: Record<
    string,
    { movementLeft?: number; movementRemaining?: number; reaction?: boolean }
  >;
  hp?: Record<string, number>;
  conditions?: Record<string, readonly (string | ActiveCondition)[]>;
  reactions?: Record<string, boolean>;
  pendingReactions?: Record<string, PendingReaction>;
};
export type MovementCommandResult = {
  ok: true;
  state: MovementCommandState;
  events: MovementEvent[];
  pending: PendingReaction[];
};
export type MovementError = { error: string; hint: string; reason: string };
export type ReactionResult = MovementCommandResult | MovementError;

function conditionsOf(state: MovementCommandState, entity: MovementCombatant) {
  const list: ActiveCondition[] = [
    ...(entity.conditions ?? []).map((id) => ({ id: id as ConditionId })),
    ...(state.conditions?.[entity.id] ?? []).map(
      (c): ActiveCondition =>
        typeof c === 'string'
          ? { id: c as ConditionId }
          : { ...c, id: c.id as ConditionId },
    ),
  ];
  return effectiveConditions(list);
}
function canReact(state: MovementCommandState, entity: MovementCombatant) {
  return (
    (state.reactions?.[entity.id] ??
      state.resources?.[entity.id]?.reaction ??
      entity.reaction ??
      true) &&
    !conditionsOf(state, entity).has('incapacitated')
  );
}
function hpOf(state: MovementCommandState, entity: MovementCombatant) {
  return state.hp?.[entity.id] ?? entity.hp;
}
function updatePosition(
  state: MovementCommandState,
  id: string,
  pos: GridPos,
  spent: number,
  budget: number,
): MovementCommandState {
  const left = Math.max(0, budget - spent);
  return {
    ...state,
    entities: state.entities.map((e) =>
      e.id === id ? { ...e, pos: { ...pos } } : e,
    ),
    resources: {
      ...state.resources,
      [id]: { ...state.resources?.[id], movementLeft: left },
    },
  };
}
function legalStep(
  state: MovementCommandState,
  entity: MovementCombatant,
  next: GridPos,
): MovementError | null {
  const dx = Math.abs(next.x - entity.pos.x),
    dy = Math.abs(next.y - entity.pos.y);
  if (Math.max(dx, dy) !== 1 || dx + dy === 0)
    return {
      error: 'Path contains a non-adjacent step.',
      hint: 'Each path step must move to a neighboring cell.',
      reason: 'non_adjacent',
    };
  if (
    !movementNeighbors(state, entity, entity.pos).some(
      (p) => cellKey(p) === cellKey(next),
    )
  )
    return {
      error: 'Path contains an illegal step.',
      hint: 'Choose an adjacent unblocked cell.',
      reason: 'blocked',
    };
  return null;
}

/** Resolve a movement path cell-by-cell, pausing when an eligible hostile may react. */
export function moveAlong(
  state: MovementCommandState,
  entityId: string,
  path: readonly GridPos[],
  mode: MovementMode = 'normal',
): MovementCommandResult | MovementError {
  const original = state.entities.find((e) => e.id === entityId);
  if (!original)
    return {
      error: 'Unknown entity.',
      hint: 'Choose an entity on the map.',
      reason: 'unknown_entity',
    };
  if (!['normal', 'disengage', 'forced'].includes(mode))
    return {
      error: 'Unknown movement mode.',
      hint: 'Use normal, disengage, or forced.',
      reason: 'invalid_mode',
    };
  if (path.length < 2 || cellKey(path[0]!) !== cellKey(original.pos))
    return {
      error: 'Path must start at the mover position and include a step.',
      hint: 'Supply the complete path from the current cell.',
      reason: 'invalid_path',
    };
  let current = state,
    spent = 0;
  const initialBudget = movementBudget(state, original);
  const events: MovementEvent[] = [],
    traversed = [original.pos],
    pending: PendingReaction[] = [];
  for (let i = 1; i < path.length; i++) {
    const mover = current.entities.find((e) => e.id === entityId)!;
    const next = path[i]!;
    const error = legalStep(current, mover, next);
    if (error) return error;
    const stepCost = movementCost(current, mover, next);
    if (mode !== 'forced' && spent + stepCost > initialBudget)
      return {
        error: 'Insufficient movement remaining.',
        hint: `You have ${initialBudget - spent} feet remaining.`,
        reason: 'insufficient_movement',
      };
    const leaving =
      mode === 'normal'
        ? current.entities
            .filter(
              (hostile) =>
                hostile.id !== mover.id &&
                hostile.team !== mover.team &&
                canReact(current, hostile) &&
                inReach(
                  mover,
                  hostile,
                  hostile.reachFt ?? 5,
                  current.map.diagonalRule,
                ) &&
                !inReach(
                  { ...mover, pos: next },
                  hostile,
                  hostile.reachFt ?? 5,
                  current.map.diagonalRule,
                ),
            )
            .sort((a, b) => a.id.localeCompare(b.id))
        : [];
    spent += mode === 'forced' ? 0 : stepCost;
    current = updatePosition(current, entityId, next, spent, initialBudget);
    traversed.push(next);
    events.push({
      type: 'EntityMoved',
      entityId,
      path: [next],
      cost: stepCost,
    });
    if (mode !== 'forced')
      events.push({ type: 'MovementSpent', entityId, feet: stepCost });
    for (const hostile of leaving) {
      const reactionId = `${hostile.id}->${entityId}@${cellKey(next)}`;
      const item: PendingReaction = {
        reactionId,
        moverId: entityId,
        hostileId: hostile.id,
        remainingPath: path.slice(i + 1).map((p) => ({ ...p })),
        mode,
      };
      pending.push(item);
      events.push(
        {
          type: 'OpportunityTriggered',
          moverId: entityId,
          attackerId: hostile.id,
        },
        {
          type: 'ReactionAvailable',
          entityId: hostile.id,
          trigger: 'opportunityAttack',
        },
      );
    }
    if (pending.length) {
      current = {
        ...current,
        pendingReactions: {
          ...current.pendingReactions,
          ...Object.fromEntries(pending.map((p) => [p.reactionId, p])),
        },
      };
      return { ok: true, state: current, events, pending };
    }
  }
  return { ok: true, state: current, events, pending };
}

/** Resolve or decline one opportunity attack, then continue the interrupted path. */
export function resolveReaction(
  state: MovementCommandState,
  reactionId: string,
  choice: 'take' | 'decline',
): ReactionResult {
  const pending = state.pendingReactions?.[reactionId];
  if (!pending)
    return {
      error: `Unknown or resolved reaction: ${reactionId}.`,
      hint: 'Choose a pending opportunity attack.',
      reason: 'unknown_reaction',
    };
  const hostile = state.entities.find((e) => e.id === pending.hostileId)!;
  const mover = state.entities.find((e) => e.id === pending.moverId)!;
  const pendingReactions = { ...state.pendingReactions };
  delete pendingReactions[reactionId];
  let current: MovementCommandState = {
    ...state,
    pendingReactions,
    reactions: { ...state.reactions, [hostile.id]: false },
  };
  const events: MovementEvent[] = [];
  events.push({
    type: 'ReactionResolved',
    entityId: hostile.id,
    used: choice === 'take',
    reactionId,
  });
  if (choice === 'take') {
    events.push({ type: 'ReactionSpent', entityId: hostile.id });
    if (hostile.opportunityAttack) {
      const attackResult = attack({
        ...hostile.opportunityAttack,
        attackerId: hostile.id,
        targetId: mover.id,
        target: { hp: hpOf(current, mover), kind: mover.kind ?? 'monster' },
      });
      if ('error' in attackResult)
        return {
          error: attackResult.error,
          hint: attackResult.hint,
          reason: 'attack_failed',
        };
      events.push(...attackResult.events);
      const hpEvent = attackResult.events.find((e) => e.type === 'HpChanged');
      if (hpEvent?.type === 'HpChanged')
        current = {
          ...current,
          hp: { ...current.hp, [mover.id]: hpEvent.to },
          entities: current.entities.map((e) =>
            e.id === mover.id ? { ...e, hp: hpEvent.to } : e,
          ),
        };
    }
  }
  if (hpOf(current, mover) <= 0 || !pending.remainingPath.length)
    return {
      ok: true,
      state: current,
      events,
      pending: Object.values(current.pendingReactions ?? {}).filter(
        (p) => p.moverId === mover.id,
      ),
    };
  const unresolvedForMover = Object.values(
    current.pendingReactions ?? {},
  ).filter((p) => p.moverId === mover.id);
  if (unresolvedForMover.length)
    return { ok: true, state: current, events, pending: unresolvedForMover };
  const liveMover = current.entities.find((e) => e.id === mover.id)!;
  const continuation = moveAlong(
    current,
    mover.id,
    [liveMover.pos, ...pending.remainingPath],
    pending.mode,
  );
  if ('error' in continuation)
    return { ok: true, state: current, events, pending: [] };
  return {
    ok: true,
    state: continuation.state,
    events: [...events, ...continuation.events],
    pending: continuation.pending,
  };
}
