import {
  roll,
  type Modifier,
  type RollBreakdown,
  type RollMode,
} from '../dice.js';
import type { RngState } from '../rng.js';
import type { Battlemap } from '@game/schema';
import { distance, rangeBand, type Placed } from '../map/geometry.js';
import { coverBetween, type CoverGrade } from '../map/cover.js';
import { hasLineOfSight } from '../map/los.js';

export type DamageRelation = 'resistant' | 'vulnerable' | 'immune';

/** Distance, cover and reach are resolved by the caller (M1-24); only their effect is passed in. */
export type AttackMapContext = {
  map: Battlemap;
  attacker: Placed;
  target: Placed;
  /** Ranged weapon normal/long range, in feet. */
  range?: { normalFt: number; longFt?: number };
  /** Melee weapon reach, in feet (defaults to 5). */
  reachFt?: number;
};

export type AttackInput = {
  attackerId: string;
  targetId: string;
  attackId: string;
  seed: RngState;
  attackBonus: number;
  /** Damage dice expression, e.g. `1d8+3`. */
  damage: string;
  damageType: string;
  mode?: RollMode;
  targetAc: number;
  /** Cover bonus to AC, already computed by the caller. */
  coverAcBonus?: number;
  /** Optional authoritative tactical facts; absent preserves the unmapped API. */
  map?: AttackMapContext;
  target: {
    hp: number;
    kind: 'pc' | 'monster';
    relations?: Record<string, DamageRelation>;
  };
};

export type AttackEvent =
  | {
      type: 'RollEvent';
      entityId: string;
      attackId: string;
      kind: 'attack' | 'damage';
      breakdown: RollBreakdown;
      mapFacts?: { distanceFt: number; cover: CoverGrade };
    }
  | {
      type: 'HpChanged';
      entityId: string;
      from: number;
      to: number;
      damage: number;
      damageType: string;
    }
  | { type: 'EntityDown'; entityId: string; outcome: 'unconscious' | 'dead' };

export type AttackResult =
  | {
      ok: true;
      hit: boolean;
      crit: boolean;
      events: AttackEvent[];
      rng: RngState;
    }
  | { error: string; hint: string };

/** SRD: resistance halves (round down), vulnerability doubles, immunity zeroes. */
export function applyDamageRelation(
  amount: number,
  relation?: DamageRelation,
): number {
  if (relation === 'immune') return 0;
  if (relation === 'resistant') return Math.floor(amount / 2);
  if (relation === 'vulnerable') return amount * 2;
  return amount;
}

/** Crit doubles the dice, never the flat modifier. */
const doubleDice = (expr: string): string =>
  expr
    .replace(/\s+/g, '')
    .replace(/^(\d+)d/i, (_, n: string) => `${Number(n) * 2}d`);

export function attack(input: AttackInput): AttackResult {
  const bad = (error: string, hint: string): AttackResult => ({ error, hint });
  if (input.attackerId === input.targetId)
    return bad('An attack needs a different target.', 'Choose another target.');
  if (!Number.isInteger(input.attackBonus) || !Number.isInteger(input.targetAc))
    return bad(
      'Attack bonus and AC must be integers.',
      'Supply integer values.',
    );
  if (!Number.isInteger(input.target.hp) || input.target.hp < 0)
    return bad(
      'Target HP is invalid.',
      'Target HP must be a non-negative integer.',
    );

  let mode = input.mode ?? 'normal';
  let mapFacts: { distanceFt: number; cover: CoverGrade } | undefined;
  if (input.map) {
    const { map, attacker, target } = input.map;
    const distanceFt = distance(attacker, target, map.diagonalRule);
    const sight = hasLineOfSight(map, attacker, target);
    const cover = coverBetween(map, attacker, target);
    if (!sight || !cover.targetable)
      return bad(
        'Target is blocked by full cover.',
        'Choose a target with line of sight.',
      );
    if (input.map.range) {
      const band = rangeBand(
        distanceFt,
        input.map.range.normalFt,
        input.map.range.longFt ?? input.map.range.normalFt,
      );
      if (band === 'out')
        return bad('Target is beyond long range.', 'Choose a closer target.');
      if (band === 'long')
        mode = mode === 'disadvantage' ? 'disadvantage' : 'disadvantage';
    } else if (distanceFt > (input.map.reachFt ?? 5)) {
      return bad(
        'Target is beyond melee reach.',
        'Choose a target within reach.',
      );
    }
    mapFacts = { distanceFt, cover: cover.grade };
  }
  const mods: Modifier[] = [
    { label: 'attack bonus', value: input.attackBonus },
    ...(mode !== 'normal' ? [{ label: mode, value: 0 }] : []),
  ];
  let rng = input.seed;
  let attackRoll: RollBreakdown;
  try {
    [attackRoll, rng] = roll('1d20', rng, {
      mode,
      modifiers: mods,
    });
  } catch (e) {
    return bad((e as Error).message, 'Check the roll mode.');
  }
  const events: AttackEvent[] = [
    {
      type: 'RollEvent',
      entityId: input.attackerId,
      attackId: input.attackId,
      kind: 'attack',
      breakdown: attackRoll,
      ...(mapFacts ? { mapFacts } : {}),
    },
  ];
  const natural = attackRoll.dice.find((d) => d.kept)!.value;
  const ac =
    input.targetAc +
    (input.coverAcBonus ??
      (input.map
        ? coverBetween(input.map.map, input.map.attacker, input.map.target)
            .acBonus
        : 0));
  const crit = natural === 20;
  const hit = natural !== 1 && (crit || attackRoll.total >= ac);
  if (!hit) return { ok: true, hit, crit: false, events, rng };

  let dmgRoll: RollBreakdown;
  try {
    [dmgRoll, rng] = roll(crit ? doubleDice(input.damage) : input.damage, rng);
  } catch (e) {
    return bad((e as Error).message, 'Use an NdM[+K] damage expression.');
  }
  events.push({
    type: 'RollEvent',
    entityId: input.attackerId,
    attackId: input.attackId,
    kind: 'damage',
    breakdown: dmgRoll,
  });
  const damage = applyDamageRelation(
    Math.max(0, dmgRoll.total),
    input.target.relations?.[input.damageType],
  );
  const to = Math.max(0, input.target.hp - damage);
  events.push({
    type: 'HpChanged',
    entityId: input.targetId,
    from: input.target.hp,
    to,
    damage,
    damageType: input.damageType,
  });
  // ponytail: M1-14 owns death saves; this is the hook outcome only.
  if (to === 0 && input.target.hp > 0)
    events.push({
      type: 'EntityDown',
      entityId: input.targetId,
      outcome: input.target.kind === 'pc' ? 'unconscious' : 'dead',
    });
  return { ok: true, hit, crit, events, rng };
}
