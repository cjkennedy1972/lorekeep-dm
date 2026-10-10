import { DMToolArgsSchema } from '@game/schema';
import {
  attack,
  type AttackMapContext,
  type AttackEvent,
} from '../combat/attack.js';
import { attackRollMode, type ActiveCondition } from '../combat/conditions.js';
import type { CharacterInput } from '../character/types.js';
import type { Catalog } from '../catalog/types.js';
import type { RngState } from '../rng.js';
import type { Placed } from '../map/geometry.js';
import { distance } from '../map/geometry.js';
import type { Battlemap } from '@game/schema';
import { fail, ok, type ToolResult } from './result.js';
import { actionBlock, spendAction, type TurnState } from './turn.js';

export type ToolAttack = {
  id: string;
  ownerId: string;
  attackBonus: number;
  damage: string;
  damageType: string;
  targetAc: number;
  reachFt?: number;
  range?: { normalFt: number; longFt?: number };
  targetKind: 'pc' | 'monster';
  relations?: Record<string, 'resistant' | 'vulnerable' | 'immune'>;
};
export type AttackToolState = {
  actors: Readonly<Record<string, CharacterInput>>;
  attacks: Readonly<Record<string, ToolAttack>>;
  hp: Readonly<Record<string, number>>;
  ac: Readonly<Record<string, number>>;
  placements?: Readonly<Record<string, Placed & { id: string }>>;
  map?: Battlemap;
  conditions?: Readonly<Record<string, readonly ActiveCondition[]>>;
  combat?: TurnState;
  catalog: Catalog;
};
export function executeAttack(
  state: AttackToolState,
  args: unknown,
  rng: RngState,
): ToolResult<{ events: AttackEvent[]; rng: RngState; combat?: TurnState }> {
  const parsed = DMToolArgsSchema.attack.safeParse(args);
  if (!parsed.success)
    return fail(
      'schema-violation',
      parsed.error.issues[0]?.message ?? 'Provide valid attack arguments.',
    );
  const { attackerId, targetId, attackId } = parsed.data;
  const blocked = actionBlock(state.combat, attackerId);
  if (blocked) return fail(blocked.code, blocked.hint);
  if (!state.actors[attackerId] && !state.placements?.[attackerId])
    return fail('unknown-entity', 'Choose an attacker present in the session.');
  if (!state.actors[targetId] && !state.placements?.[targetId])
    return fail('unknown-entity', 'Choose a target present in the session.');
  const definition = state.attacks[attackId];
  if (!definition)
    return fail(
      'not-equipped',
      "Choose an attack granted by the attacker's creature or equipped weapon.",
    );
  if (definition.ownerId !== attackerId)
    return fail('not-equipped', 'Choose an attack belonging to the attacker.');
  if ((state.hp[targetId] ?? 0) <= 0)
    return fail(
      'target-already-down',
      'Choose a target that is still standing.',
    );
  const targetPlacement = state.placements?.[targetId];
  const attackerPlacement = state.placements?.[attackerId];
  if (state.map && targetPlacement && attackerPlacement) {
    const feet = distance(
      attackerPlacement,
      targetPlacement,
      state.map.diagonalRule,
    );
    const max =
      definition.range?.longFt ??
      definition.range?.normalFt ??
      definition.reachFt ??
      5;
    if (feet > max)
      return fail(
        'out-of-range',
        `${targetId} is ${feet} ft away; this attack reaches ${max} ft. Choose a closer target or move first.`,
      );
  }
  const feet =
    state.map && targetPlacement && attackerPlacement
      ? distance(attackerPlacement, targetPlacement, state.map.diagonalRule)
      : 5;
  const mode = attackRollMode(
    state.conditions?.[attackerId] ?? [],
    state.conditions?.[targetId] ?? [],
    feet,
  );
  const result = attack({
    attackerId,
    targetId,
    attackId,
    seed: rng,
    attackBonus: definition.attackBonus,
    damage: definition.damage,
    damageType: definition.damageType,
    targetAc: state.ac[targetId] ?? definition.targetAc,
    target: {
      hp: state.hp[targetId]!,
      kind: definition.targetKind,
      relations: definition.relations,
    },
    mode,
    ...(state.map && attackerPlacement && targetPlacement
      ? {
          map: {
            map: state.map,
            attacker: attackerPlacement,
            target: targetPlacement,
            ...(definition.range
              ? { range: definition.range }
              : { reachFt: definition.reachFt }),
          } satisfies AttackMapContext,
        }
      : {}),
  });
  if ('error' in result)
    return fail(
      result.error.includes('range') || result.error.includes('reach')
        ? 'out-of-range'
        : 'no-line-of-sight',
      result.hint,
    );
  return ok(
    {
      events: result.events,
      rng: result.rng,
      combat: spendAction(state.combat, attackerId),
    },
    result.events.map((event) => event.type),
    `${attackerId} ${result.hit ? 'hits' : 'misses'} ${targetId}${result.crit ? ' critically' : ''}.`,
  );
}
