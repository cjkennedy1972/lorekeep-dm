import {
  roll,
  type Modifier,
  type RollBreakdown,
  type RollMode,
} from '../dice.js';
import type { RngState } from '../rng.js';

export type DamageRelation = 'resistant' | 'vulnerable' | 'immune';

/** Distance, cover and reach are resolved by the caller (M1-24); only their effect is passed in. */
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

  const mods: Modifier[] = [
    { label: 'attack bonus', value: input.attackBonus },
  ];
  let rng = input.seed;
  let attackRoll: RollBreakdown;
  try {
    [attackRoll, rng] = roll('1d20', rng, {
      mode: input.mode,
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
    },
  ];
  const natural = attackRoll.dice.find((d) => d.kept)!.value;
  const ac = input.targetAc + (input.coverAcBonus ?? 0);
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
