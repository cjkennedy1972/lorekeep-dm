import { DMToolArgsSchema } from '@game/schema';
import type { CharacterInput } from '../character/types.js';
import {
  CONDITION_IDS,
  applyCondition,
  removeCondition,
  type ConditionState,
  type ConditionEvent,
} from '../combat/conditions.js';
import type { ToolResult } from './result.js';
import { fail, ok } from './result.js';

export type ConditionToolState = {
  actors: Readonly<Record<string, CharacterInput>>;
  conditions: ConditionState;
  immunities?: Readonly<Record<string, readonly string[]>>;
};
export function executeCondition(
  state: ConditionToolState,
  name: 'apply_condition' | 'remove_condition',
  args: unknown,
): ToolResult<{ events: ConditionEvent[] }> {
  const parsed = DMToolArgsSchema[name].safeParse(args);
  if (!parsed.success)
    return fail(
      'schema-violation',
      parsed.error.issues[0]?.message ?? 'Provide valid condition arguments.',
    );
  const { targetId, conditionId, source, duration } = parsed.data;
  if (!state.actors[targetId])
    return fail(
      'unknown-entity',
      `Choose a session entity: ${Object.keys(state.actors).slice(0, 10).join(', ')}.`,
    );
  const id = conditionId.replace('srd:condition/', '');
  if (!CONDITION_IDS.includes(id as never))
    return fail('unknown-condition', 'Choose a supported SRD condition.');
  if (name === 'apply_condition') {
    if (id === 'unconscious')
      return fail(
        'condition-engine-owned',
        'Unconscious is applied automatically when HP reaches 0.',
      );
    if (state.conditions[targetId]?.some((condition) => condition.id === id))
      return fail(
        'already-applied',
        'That condition is already active; remove it before applying it again.',
      );
    if (state.immunities?.[targetId]?.includes(id))
      return fail(
        'immune',
        'Choose a target that is not immune to this condition.',
      );
    const durationRounds =
      duration === 'end-of-next-turn'
        ? 1
        : duration === '1-minute'
          ? 10
          : duration === '1-hour'
            ? 600
            : undefined;
    const result = applyCondition(targetId, {
      id: id as never,
      source,
      ...(durationRounds ? { durationRounds } : {}),
    });
    if ('error' in result) return fail('schema-violation', result.hint);
    return ok(
      { events: result.events as ConditionEvent[] },
      ['ConditionApplied'],
      `Applied ${id} to ${targetId}.`,
    );
  }
  const result = removeCondition(state.conditions, targetId, id as never);
  if ('error' in result) return fail('unknown-condition', result.hint);
  return ok(
    { events: result.events },
    ['ConditionRemoved'],
    `Removed ${id} from ${targetId}.`,
  );
}
