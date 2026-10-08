import { DMToolCallSchema, type DMToolErrorCode } from '@game/schema';
import type { RngState } from '../rng.js';
import { executeCheck } from './check.js';
import { executeAttack } from './attack.js';
import { executeSpell } from './spell.js';
import { executeCondition } from './conditions.js';
import { fail, type ToolResult } from './result.js';
import type { CheckToolState } from './check.js';
import type { AttackToolState } from './attack.js';
import type { SpellToolState } from './spell.js';
import type { ConditionToolState } from './conditions.js';
import { executeStartCombat, executeEndCombat } from './combat.js';
import { executeMoveTo, executeSuggestAreaTarget } from './movement.js';
import type { CombatToolState } from './combat.js';
import type { MovementToolState, AreaToolState } from './movement.js';

export type ToolExecutorState = CheckToolState &
  AttackToolState &
  SpellToolState &
  ConditionToolState &
  CombatToolState &
  MovementToolState &
  AreaToolState;
export function execute(
  state: ToolExecutorState,
  toolCall: unknown,
  rng: RngState,
): ToolResult<unknown> {
  if (!toolCall || typeof toolCall !== 'object')
    return fail(
      'schema-violation',
      'Provide a tool call object with a name and arguments.',
    );
  const call = toolCall as { name?: unknown; args?: unknown };
  if (typeof call.name !== 'string')
    return fail(
      'missing-argument',
      'Provide a tool name and arguments object.',
    );
  const supported = [
    'request_check',
    'request_save',
    'attack',
    'cast_spell',
    'apply_condition',
    'remove_condition',
    'start_combat',
    'end_combat',
    'move_to',
    'suggest_area_target',
  ];
  if (!supported.includes(call.name))
    return fail('unknown-tool', 'Use one of the supported M2-10 tools.');
  if (!call.args || typeof call.args !== 'object')
    return fail(
      'missing-argument',
      'Provide the arguments required by this tool.',
    );
  const rawArgs = call.args as Record<string, unknown>;
  for (const key of ['actorId', 'attackerId', 'targetId', 'casterId']) {
    const value = rawArgs[key];
    if (typeof value === 'string' && !/^ent_[a-z0-9_-]{1,32}$/.test(value))
      return fail(
        'malformed-ref',
        `${key} must be a valid session entity reference.`,
      );
  }
  const serialized = JSON.stringify(call.args);
  if (serialized && /"(?:x|y|distance|feet)"\s*:/.test(serialized))
    return fail(
      'schema-violation',
      'Coordinates and model-supplied distances are not accepted; reference an entity, marker, or engine option.',
    );
  if (call.name === 'request_check' || call.name === 'request_save') {
    const raw = call.args as Record<string, unknown>;
    if (
      typeof raw.dc === 'number' &&
      (!Number.isInteger(raw.dc) || raw.dc < 1 || raw.dc > 30)
    )
      return fail('dc-out-of-range', 'Choose a DC from 1 through 30.');
    return executeCheck(state, call.name, call.args, rng);
  }
  if (call.name === 'attack') return executeAttack(state, call.args, rng);
  if (call.name === 'cast_spell') return executeSpell(state, call.args, rng);
  if (call.name === 'apply_condition' || call.name === 'remove_condition')
    return executeCondition(state, call.name, call.args);
  if (call.name === 'start_combat')
    return executeStartCombat(state, call.args, rng);
  if (call.name === 'end_combat') return executeEndCombat(state, call.args);
  if (call.name === 'move_to') return executeMoveTo(state, call.args);
  if (call.name === 'suggest_area_target')
    return executeSuggestAreaTarget(state, call.args);
  const checked = DMToolCallSchema.safeParse(toolCall);
  return checked.success
    ? fail('unknown-tool', 'This tool is not implemented by this executor.')
    : (fail(
        'schema-violation',
        checked.error.issues[0]?.message ??
          'Tool arguments do not match the schema.',
      ) as ToolResult<never>);
}
export type { DMToolErrorCode };
export * from './check.js';
export * from './attack.js';
export * from './spell.js';
export * from './conditions.js';
export * from './result.js';
