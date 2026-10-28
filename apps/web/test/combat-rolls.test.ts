import { describe, expect, it } from 'vitest';
import {
  summarizeCombatRolls,
  type RollCard,
} from '../src/features/narration/combatRolls.js';

const kinds: Record<string, 'pc' | 'monster'> = {
  ent_aria: 'pc',
  ent_bran: 'pc',
  ent_goblin: 'monster',
};
const kindOf = (id: string) => kinds[id];

const ownAttack = (total: number, natural: number) => ({
  type: 'RollEvent',
  actorId: 'ent_aria',
  label: 'attack equipment:javelin',
  dice: '1d20',
  rolls: [natural],
  modifier: 4,
  total,
});
const ownDamage = (total: number) => ({
  type: 'RollEvent',
  actorId: 'ent_aria',
  label: 'damage equipment:javelin',
  dice: '1d6',
  rolls: [total],
  modifier: 0,
  total,
});
const concealedAttack = (total: number) => ({
  type: 'RollEvent',
  actorId: 'ent_bran',
  label: 'attack',
  dice: '1d20',
  rolls: [total - 4],
  total,
});
const concealedDamage = (total: number) => ({
  type: 'RollEvent',
  actorId: 'ent_bran',
  label: 'damage',
  dice: '1d6',
  rolls: [total],
  total,
});
const hpChanged = (entityId: string, from: number, to: number) => ({
  type: 'HpChanged',
  entityId,
  from,
  to,
  damage: from - to,
  damageType: 'piercing',
});

function one(events: unknown[]): RollCard {
  const cards = summarizeCombatRolls(events, kindOf);
  expect(cards).toHaveLength(1);
  return cards[0]!;
}

describe('summarizeCombatRolls', () => {
  it('pairs an owned attack, its damage and the HP change into one hit card', () => {
    const card = one([
      ownAttack(17, 13),
      ownDamage(5),
      hpChanged('ent_goblin', 7, 2),
    ]);
    expect(card).toMatchObject({
      attackerId: 'ent_aria',
      targetId: 'ent_goblin',
      weapon: 'Javelin',
      owned: true,
      hit: true,
      attackTotal: 17,
      damage: 5,
      targetKind: 'monster',
      down: false,
    });
  });

  it('hides the monster HP number and reports still standing', () => {
    const card = one([
      ownAttack(17, 13),
      ownDamage(5),
      hpChanged('ent_goblin', 7, 2),
    ]);
    expect(card.targetHp).toBeUndefined();
    expect(card.standing).toBe(true);
  });

  it('reports a monster at 0 HP as down', () => {
    const card = one([
      ownAttack(17, 13),
      ownDamage(9),
      hpChanged('ent_goblin', 7, 0),
    ]);
    expect(card.down).toBe(true);
    expect(card.standing).toBeUndefined();
  });

  it('treats an attack with no following damage as a miss', () => {
    const card = one([ownAttack(6, 2)]);
    expect(card.hit).toBe(false);
    expect(card.damage).toBeUndefined();
    expect(card.targetId).toBeUndefined();
  });

  it('never shows the attack total for a concealed roll from another seat', () => {
    const card = one([
      concealedAttack(15),
      concealedDamage(4),
      hpChanged('ent_aria', 12, 8),
    ]);
    expect(card.owned).toBe(false);
    expect(card.attackTotal).toBeUndefined();
    expect(card.hit).toBe(true);
  });

  it('shows PC HP numbers because the party already sees them', () => {
    const card = one([
      concealedAttack(15),
      concealedDamage(4),
      hpChanged('ent_aria', 12, 8),
    ]);
    expect(card.targetKind).toBe('pc');
    expect(card.targetHp).toEqual({ from: 12, to: 8 });
    expect(card.damage).toBe(4);
  });

  it('hides damage numbers for a concealed hit on a monster', () => {
    const card = one([
      concealedAttack(15),
      concealedDamage(4),
      hpChanged('ent_goblin', 7, 3),
    ]);
    expect(card.damage).toBeUndefined();
    expect(card.standing).toBe(true);
  });

  it('builds a card per attack in a batch, in order', () => {
    const cards = summarizeCombatRolls(
      [
        ownAttack(6, 2),
        ownAttack(18, 14),
        ownDamage(3),
        hpChanged('ent_goblin', 7, 4),
      ],
      kindOf,
    );
    expect(cards.map((c) => c.hit)).toEqual([false, true]);
  });

  it('ignores non-attack roll events such as saves', () => {
    const cards = summarizeCombatRolls(
      [
        {
          type: 'RollEvent',
          actorId: 'ent_aria',
          label: 'save',
          dice: '1d20',
          rolls: [11],
          modifier: 2,
          total: 13,
        },
      ],
      kindOf,
    );
    expect(cards).toEqual([]);
  });

  it('ignores malformed events without failing the batch', () => {
    const cards = summarizeCombatRolls(
      [null, 'x', { type: 'HpChanged' }, ownAttack(17, 13), ownDamage(5)],
      kindOf,
    );
    expect(cards).toHaveLength(1);
  });
});
