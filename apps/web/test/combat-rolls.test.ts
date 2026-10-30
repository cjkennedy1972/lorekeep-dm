import { describe, expect, it } from 'vitest';
import {
  rollCardText,
  summarizeCombatRolls,
  weaponName,
  type CombatantFacts,
  type RollCard,
} from '../src/features/narration/combatRolls.js';

// ent_aria is the viewer's own PC. ent_bran and ent_thorin belong to other seats. ent_goblin is a monster.
const combatants: Record<string, CombatantFacts> = {
  ent_aria: { kind: 'pc', hpState: 'healthy' },
  ent_bran: { kind: 'pc', hpState: 'wounded' },
  ent_thorin: { kind: 'pc', hpState: 'healthy' },
  ent_goblin: { kind: 'monster', hpState: 'healthy' },
};
const viewer = new Set(['ent_aria']);
const names: Record<string, string> = {
  ent_aria: 'Aria',
  ent_bran: 'Bran',
  ent_thorin: 'Thorin',
  ent_goblin: 'Goblin',
};
const nameOf = (id: string) => names[id] ?? id;

const roll = (
  actorId: string,
  label: string,
  total: number,
  extra: Record<string, unknown> = {},
) => ({
  type: 'RollEvent',
  actorId,
  label,
  dice: '1d20',
  rolls: [total],
  total,
  ...extra,
});
// The viewer's own attack carries its attack id and modifier.
const ownAttack = (total: number) =>
  roll('ent_aria', 'attack equipment:javelin', total, { modifier: 4 });
const ownDamage = (total: number) =>
  roll('ent_aria', 'damage equipment:javelin', total);
const spellDamage = (total: number) =>
  roll('ent_aria', 'damage spell:fire-bolt', total);
// Another seat's PC attacks: the server strips the attack id and modifier.
const concealedAttack = (total: number, actor = 'ent_bran') =>
  roll(actor, 'attack', total);
const concealedDamage = (total: number, actor = 'ent_bran') =>
  roll(actor, 'damage', total);
// A monster attack keeps its attack id, modifier and total on the wire.
const monsterAttack = (total: number) =>
  roll('ent_goblin', 'attack monster:goblin:claw', total, { modifier: 4 });
const monsterDamage = (total: number) =>
  roll('ent_goblin', 'damage monster:goblin:claw', total);
const hpChanged = (entityId: string, from: number, to: number) => ({
  type: 'HpChanged',
  entityId,
  from,
  to,
  damage: from - to,
  damageType: 'piercing',
});

function one(events: unknown[]): RollCard {
  const cards = summarizeCombatRolls(events, combatants, viewer);
  expect(cards).toHaveLength(1);
  return cards[0]!;
}

describe('summarizeCombatRolls: the viewer’s own attacks', () => {
  it('shows the attack total and the monster damage for the viewer’s own hit', () => {
    const card = one([
      ownAttack(17),
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
      standing: true,
    });
  });

  it('hides the monster HP number and reports a monster at 0 HP as down', () => {
    const card = one([
      ownAttack(17),
      ownDamage(9),
      hpChanged('ent_goblin', 7, 0),
    ]);
    expect(card.targetHp).toBeUndefined();
    expect(card.down).toBe(true);
    expect(card.standing).toBeUndefined();
  });

  it('treats an attack with no following damage as a miss with no target', () => {
    const card = one([ownAttack(6)]);
    expect(card.hit).toBe(false);
    expect(card.damage).toBeUndefined();
    expect(card.targetId).toBeUndefined();
    expect(card.attackTotal).toBe(6);
  });
});

describe('summarizeCombatRolls: monster attacks', () => {
  it('never shows a monster attack total, even though the attack id is present', () => {
    const card = one([
      monsterAttack(14),
      monsterDamage(5),
      hpChanged('ent_thorin', 20, 15),
    ]);
    expect(card.owned).toBe(false);
    expect(card.attackTotal).toBeUndefined();
    expect(card.hit).toBe(true);
  });

  it('shows no damage and no HP change when the monster hits another seat’s PC', () => {
    const card = one([
      monsterAttack(14),
      monsterDamage(5),
      hpChanged('ent_thorin', 20, 15),
    ]);
    expect(card.targetId).toBe('ent_thorin');
    expect(card.damage).toBeUndefined();
    expect(card.targetHp).toBeUndefined();
  });

  it('shows damage and the HP change when the monster hits the viewer’s own PC, still without the total', () => {
    const card = one([
      monsterAttack(14),
      monsterDamage(5),
      hpChanged('ent_aria', 20, 15),
    ]);
    expect(card.attackTotal).toBeUndefined();
    expect(card.damage).toBe(5);
    expect(card.targetHp).toEqual({ from: 20, to: 15 });
  });

  it('never prints a monster total or a PC HP change in the card text for another seat’s PC', () => {
    const card = one([
      monsterAttack(14),
      monsterDamage(5),
      hpChanged('ent_thorin', 20, 15),
    ]);
    const text = rollCardText(card, nameOf);
    expect(text).toBe('Goblin hits Thorin with Claw. Thorin is still healthy.');
    expect(text).not.toMatch(/\d/);
    expect(text).not.toContain('attack roll');
  });
});

describe('summarizeCombatRolls: other seats’ attacks', () => {
  it('shows no attack total and no damage on a concealed hit against a monster', () => {
    const card = one([
      concealedAttack(15),
      concealedDamage(4),
      hpChanged('ent_goblin', 7, 3),
    ]);
    expect(card.owned).toBe(false);
    expect(card.attackTotal).toBeUndefined();
    expect(card.damage).toBeUndefined();
    expect(card.standing).toBe(true);
  });

  it('shows damage and the HP change when another seat hits the viewer’s own PC', () => {
    const card = one([
      concealedAttack(15),
      concealedDamage(4),
      hpChanged('ent_aria', 12, 8),
    ]);
    expect(card.targetKind).toBe('pc');
    expect(card.damage).toBe(4);
    expect(card.targetHp).toEqual({ from: 12, to: 8 });
  });

  it('shows hit with a wound word, and no damage or HP numbers, when it hits another seat’s PC', () => {
    const card = one([
      concealedAttack(15, 'ent_goblin'),
      concealedDamage(4, 'ent_goblin'),
      hpChanged('ent_bran', 12, 8),
    ]);
    expect(card.hit).toBe(true);
    expect(card.damage).toBeUndefined();
    expect(card.targetHp).toBeUndefined();
    expect(card.wound).toBe('bloodied');
    expect(rollCardText(card, nameOf)).toBe(
      'Goblin hits Bran. Bran is bloodied.',
    );
  });

  it('reports another seat’s PC at 0 HP as down, without numbers', () => {
    const card = one([
      concealedAttack(15, 'ent_goblin'),
      concealedDamage(9, 'ent_goblin'),
      hpChanged('ent_thorin', 9, 0),
    ]);
    expect(card.down).toBe(true);
    expect(card.damage).toBeUndefined();
    expect(card.targetHp).toBeUndefined();
  });
});

describe('summarizeCombatRolls: every hit on another seat’s PC gets a coarse status', () => {
  it('says the PC is still healthy after a hit, with no numbers', () => {
    const card = one([
      concealedAttack(15, 'ent_bran'),
      concealedDamage(4, 'ent_bran'),
      hpChanged('ent_thorin', 20, 16),
    ]);
    expect(card.hit).toBe(true);
    expect(card.steady).toBe(true);
    const text = rollCardText(card, nameOf);
    expect(text).toBe('Bran hits Thorin. Thorin is still healthy.');
    expect(text).not.toMatch(/\d/);
  });

  it('says the PC is bloodied when the hit leaves it wounded', () => {
    const cards = summarizeCombatRolls(
      [
        concealedAttack(15, 'ent_bran'),
        concealedDamage(4, 'ent_bran'),
        hpChanged('ent_thorin', 20, 12),
      ],
      { ...combatants, ent_thorin: { kind: 'pc', hpState: 'wounded' } },
      viewer,
    );
    expect(cards[0]!.hit).toBe(true);
    expect(cards[0]!.wound).toBe('bloodied');
    expect(rollCardText(cards[0]!, nameOf)).toBe(
      'Bran hits Thorin. Thorin is bloodied.',
    );
  });

  it('says the PC is down when the hit takes it to 0, with no numbers', () => {
    const card = one([
      concealedAttack(15, 'ent_bran'),
      concealedDamage(9, 'ent_bran'),
      hpChanged('ent_thorin', 9, 0),
    ]);
    const text = rollCardText(card, nameOf);
    expect(text).toBe('Bran hits Thorin. Thorin is down.');
    expect(text).not.toMatch(/\d/);
  });

  it('uses an hpState on the HpChanged event for a monster when present, without to/from numbers', () => {
    const down = one([
      ownAttack(17),
      ownDamage(9),
      { type: 'HpChanged', entityId: 'ent_goblin', hpState: 'down' },
    ]);
    expect(down.down).toBe(true);
    expect(down.standing).toBeUndefined();
    expect(rollCardText(down, nameOf)).toBe(
      'Aria hits Goblin with Javelin for 9. (attack roll 17) Goblin is down.',
    );

    const standing = one([
      ownAttack(17),
      ownDamage(2),
      { type: 'HpChanged', entityId: 'ent_goblin', hpState: 'wounded' },
    ]);
    expect(standing.down).toBe(false);
    expect(standing.standing).toBe(true);
  });
});

describe('summarizeCombatRolls: matching a damage roll to its attack', () => {
  it('does not count a miss as a hit when a spell damage roll from the same caster follows', () => {
    const cards = summarizeCombatRolls(
      [ownAttack(6), spellDamage(7), hpChanged('ent_goblin', 7, 0)],
      combatants,
      viewer,
    );
    expect(cards).toHaveLength(1);
    expect(cards[0]!.hit).toBe(false);
    expect(cards[0]!.targetId).toBeUndefined();
    expect(cards[0]!.damage).toBeUndefined();
  });

  it('does not pair a miss with a damage roll from a different actor', () => {
    const cards = summarizeCombatRolls(
      [concealedAttack(6), ownDamage(3), hpChanged('ent_goblin', 7, 4)],
      combatants,
      viewer,
    );
    expect(cards[0]!.hit).toBe(false);
    expect(cards[0]!.targetId).toBeUndefined();
  });

  it('pairs an attack only with the damage roll that immediately follows it', () => {
    const cards = summarizeCombatRolls(
      [
        ownAttack(6),
        ownAttack(18),
        ownDamage(3),
        hpChanged('ent_goblin', 7, 4),
      ],
      combatants,
      viewer,
    );
    expect(cards.map((c) => c.hit)).toEqual([false, true]);
    expect(cards[1]!.targetId).toBe('ent_goblin');
  });
});

describe('summarizeCombatRolls: batch shape', () => {
  it('ignores non-attack roll events such as saves', () => {
    const cards = summarizeCombatRolls(
      [roll('ent_aria', 'save', 13, { modifier: 2 })],
      combatants,
      viewer,
    );
    expect(cards).toEqual([]);
  });

  it('ignores malformed events without failing the batch', () => {
    const cards = summarizeCombatRolls(
      [null, 'x', { type: 'HpChanged' }, ownAttack(17), ownDamage(5)],
      combatants,
      viewer,
    );
    expect(cards).toHaveLength(1);
  });
});

describe('weaponName', () => {
  it('humanizes a catalog attack id', () => {
    expect(weaponName('equipment:longsword')).toBe('Longsword');
    expect(weaponName('equipment:light-crossbow')).toBe('Light Crossbow');
  });

  it('drops an item UUID instead of printing its fragments as a weapon name', () => {
    expect(
      weaponName('equipment:823b31cc-e671-4ae2-b45e-46e7a0b26c50'),
    ).toBeUndefined();
    expect(weaponName('823b31cc-e671-4ae2-b45e-46e7a0b26c50')).toBeUndefined();
  });

  it('keeps the readable words around an embedded UUID', () => {
    expect(
      weaponName('equipment:823b31cc-e671-4ae2-b45e-46e7a0b26c50-staff'),
    ).toBe('Staff');
  });

  it('keeps the card sentence free of a UUID fragment', () => {
    const itemId = 'equipment:823b31cc-e671-4ae2-b45e-46e7a0b26c50';
    const card = one([
      roll('ent_goblin', `attack ${itemId}`, 14, { modifier: 4 }),
      roll('ent_goblin', `damage ${itemId}`, 5),
      hpChanged('ent_aria', 20, 15),
    ]);
    expect(rollCardText(card, nameOf)).not.toMatch(/[0-9a-f]{8}-/i);
  });
});
