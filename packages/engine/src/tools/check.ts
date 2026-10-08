import { DMToolArgsSchema, type DMToolErrorCode } from '@game/schema';
import type { Ability } from '@game/schema';
import { abilityModifier, proficiencyBonus } from '../dice.js';
import {
  abilityCheck,
  savingThrow,
  type CheckResult,
} from '../combat/checks.js';
import type { ActiveCondition } from '../combat/conditions.js';
import type { CharacterInput } from '../character/types.js';
import type { RngState } from '../rng.js';
import type { Catalog } from '../catalog/types.js';
import { fail, ok, type ToolResult } from './result.js';

export type CheckToolState = {
  actors: Readonly<Record<string, CharacterInput>>;
  conditions?: Readonly<Record<string, readonly ActiveCondition[]>>;
  catalog: Catalog;
};
export type CheckToolSuccess = { result: CheckResult; rng: RngState };

export function executeCheck(
  state: CheckToolState,
  name: 'request_check' | 'request_save',
  args: unknown,
  rng: RngState,
): ToolResult<CheckToolSuccess> {
  const parsed = DMToolArgsSchema[name].safeParse(args);
  if (!parsed.success)
    return fail(
      'schema-violation',
      parsed.error.issues[0]?.message ?? 'Provide valid check arguments.',
    );
  const data = parsed.data as {
    actorId: string;
    ability: Ability;
    dc: number;
    dcReason?: string;
    source?: string;
    skill?: string;
    advantage?: 'normal' | 'advantage' | 'disadvantage';
  };
  const actorId = data.actorId;
  const actor = state.actors[actorId];
  if (!actor)
    return fail(
      'unknown-entity',
      `Choose an actor in this session: ${Object.keys(state.actors).slice(0, 10).join(', ')}.`,
    );
  const skills = [
    'acrobatics',
    'animal-handling',
    'arcana',
    'athletics',
    'deception',
    'history',
    'insight',
    'intimidation',
    'investigation',
    'medicine',
    'nature',
    'perception',
    'performance',
    'persuasion',
    'religion',
    'sleight-of-hand',
    'stealth',
    'survival',
  ];
  if (
    name === 'request_check' &&
    data.skill &&
    !skills.includes(data.skill.replace('srd:skill/', ''))
  )
    return fail('unknown-skill', 'Choose one of the SRD skills.');
  if (
    name === 'request_check' &&
    (state.conditions?.[actorId] ?? []).some((condition) =>
      ['unconscious', 'stunned', 'incapacitated'].includes(condition.id),
    )
  )
    return fail('incapacitated-actor', 'Choose an actor able to take actions.');
  const ability: Ability = data.ability;
  const trained =
    name === 'request_check'
      ? !!data.skill &&
        actor.proficiencies.skills.includes(
          data.skill.replace('srd:skill/', ''),
        )
      : actor.proficiencies.saves.includes(ability);
  const input = {
    ability,
    modifier: abilityModifier(actor.abilities[ability]),
    ...(name === 'request_check' && data.skill
      ? { skill: data.skill.replace('srd:skill/', '') }
      : {}),
    ...(trained ? { proficiencyBonus: proficiencyBonus(actor.level) } : {}),
    dc: data.dc,
    dcReason: (name === 'request_check' ? data.dcReason : data.source) ?? '',
    ...(name === 'request_check' && data.advantage
      ? { mode: data.advantage }
      : {}),
    conditions: state.conditions?.[actorId] ?? [],
  };
  const [result, next] =
    name === 'request_check'
      ? abilityCheck(input, rng)
      : savingThrow(input, rng);
  if ('error' in result) return fail('dc-out-of-range', result.hint);
  return ok(
    { result, rng: next },
    [`RollEvent`],
    `${actor.name} rolls ${name === 'request_check' ? 'a check' : 'a save'}: ${result.total} vs DC ${result.dc}, ${result.success ? 'success' : 'failure'}.`,
  );
}

export function schemaError(
  code: DMToolErrorCode,
  hint: string,
): ToolResult<never> {
  return fail(code, hint);
}
