import type { RollMode } from '../dice.js';
import type { CombatEvent, CombatState } from './state.js';
import { startTurn, type CommandResult } from './commands.js';

export type ConditionId =
  | 'prone'
  | 'grappled'
  | 'restrained'
  | 'poisoned'
  | 'frightened'
  | 'stunned'
  | 'unconscious'
  | 'incapacitated';

export type ActiveCondition = {
  id: ConditionId;
  source?: string;
  /** Rounds left, ticked down at the end of the affected entity's turn; omitted = until removed. */
  durationRounds?: number;
};
export type ConditionState = Record<string, ActiveCondition[]>;

export type ConditionEvent =
  | { type: 'ConditionApplied'; entityId: string; condition: ActiveCondition }
  | { type: 'ConditionRemoved'; entityId: string; id: ConditionId }
  | { type: 'ConditionsTicked'; entityId: string }
  | { type: 'ActionsSkipped'; entityId: string; reason: string };

export const CONDITION_IDS: readonly ConditionId[] = [
  'prone',
  'grappled',
  'restrained',
  'poisoned',
  'frightened',
  'stunned',
  'unconscious',
  'incapacitated',
];

export function applyConditionEvent(
  state: ConditionState,
  event: ConditionEvent,
): ConditionState {
  const list = state[event.entityId] ?? [];
  switch (event.type) {
    case 'ConditionApplied':
      return {
        ...state,
        [event.entityId]: [
          ...list.filter((c) => c.id !== event.condition.id),
          event.condition,
        ],
      };
    case 'ConditionRemoved':
      return {
        ...state,
        [event.entityId]: list.filter((c) => c.id !== event.id),
      };
    case 'ConditionsTicked':
      return {
        ...state,
        [event.entityId]: list
          .map((c) =>
            c.durationRounds === undefined
              ? c
              : { ...c, durationRounds: c.durationRounds - 1 },
          )
          .filter(
            (c) => c.durationRounds === undefined || c.durationRounds > 0,
          ),
      };
    case 'ActionsSkipped':
      return state;
  }
}

export const replayConditions = (
  start: ConditionState,
  events: readonly ConditionEvent[],
): ConditionState => events.reduce(applyConditionEvent, start);

export function applyCondition(
  entityId: string,
  condition: ActiveCondition,
):
  | CommandResult
  | { ok: true; events: ConditionEvent[] }
  | { error: string; hint: string } {
  if (!CONDITION_IDS.includes(condition.id))
    return {
      error: `Unknown condition: ${condition.id}.`,
      hint: `Use one of: ${CONDITION_IDS.join(', ')}.`,
    };
  if (
    condition.durationRounds !== undefined &&
    (!Number.isInteger(condition.durationRounds) ||
      condition.durationRounds < 1)
  )
    return {
      error: 'Condition duration must be a positive whole number of rounds.',
      hint: 'Omit durationRounds for a condition that lasts until removed.',
    };
  return {
    ok: true,
    events: [{ type: 'ConditionApplied', entityId, condition }],
  };
}

export function removeCondition(
  state: ConditionState,
  entityId: string,
  id: ConditionId,
): { ok: true; events: ConditionEvent[] } | { error: string; hint: string } {
  if (!state[entityId]?.some((c) => c.id === id))
    return {
      error: `${entityId} does not have ${id}.`,
      hint: 'Only remove conditions that are currently active.',
    };
  return { ok: true, events: [{ type: 'ConditionRemoved', entityId, id }] };
}

/** Event to emit at the end of an entity's turn so timed conditions expire. */
export const tickConditions = (entityId: string): ConditionEvent => ({
  type: 'ConditionsTicked',
  entityId,
});

/** Active ids plus the ones they imply (unconscious => incapacitated + prone; stunned => incapacitated). */
export function effectiveConditions(
  list: readonly ActiveCondition[] = [],
): Set<ConditionId> {
  const ids = new Set(list.map((c) => c.id));
  if (ids.has('unconscious')) ids.add('incapacitated').add('prone');
  if (ids.has('stunned')) ids.add('incapacitated');
  return ids;
}

const combine = (adv: boolean, dis: boolean): RollMode =>
  adv && dis ? 'normal' : adv ? 'advantage' : dis ? 'disadvantage' : 'normal';

/** Roll mode for an attack. Prone target: advantage within 5 ft, disadvantage beyond (ranged). */
export function attackRollMode(
  attacker: readonly ActiveCondition[],
  target: readonly ActiveCondition[],
  distanceFeet: number,
): RollMode {
  const a = effectiveConditions(attacker);
  const t = effectiveConditions(target);
  const adv =
    t.has('restrained') ||
    t.has('stunned') ||
    t.has('unconscious') ||
    (t.has('prone') && distanceFeet <= 5);
  const dis =
    a.has('prone') ||
    a.has('restrained') ||
    a.has('poisoned') ||
    a.has('frightened') ||
    (t.has('prone') && distanceFeet > 5);
  return combine(adv, dis);
}

/** Why an entity cannot take actions/reactions, or null. */
export function actionBlockReason(
  list: readonly ActiveCondition[] = [],
): string | null {
  const ids = effectiveConditions(list);
  for (const id of ['unconscious', 'stunned', 'incapacitated'] as const)
    if (ids.has(id)) return `${id} creatures cannot take actions or reactions`;
  return null;
}

/** startTurn that spends action resources (and movement if speed is 0) when conditions forbid them. */
export function startTurnWithConditions(
  state: CombatState,
  conditions: ConditionState,
  entityId: string,
):
  | { ok: true; events: (CombatEvent | ConditionEvent)[] }
  | { error: string; hint: string } {
  const started = startTurn(state, entityId);
  if (!('ok' in started)) return started;
  const list = conditions[entityId];
  const events: (CombatEvent | ConditionEvent)[] = [...started.events];
  const reason = actionBlockReason(list);
  const ids = effectiveConditions(list);
  const speedZero =
    ids.has('grappled') ||
    ids.has('restrained') ||
    ids.has('stunned') ||
    ids.has('unconscious');
  const speed = state.combatants.find((c) => c.id === entityId)?.speed ?? 0;
  if (reason) {
    events.push(
      { type: 'ActionSpent', entityId },
      { type: 'BonusActionSpent', entityId },
      { type: 'ReactionSpent', entityId },
      { type: 'ActionsSkipped', entityId, reason },
    );
  }
  if (speedZero && speed > 0)
    events.push({ type: 'MovementSpent', entityId, feet: speed });
  return { ok: true, events };
}
