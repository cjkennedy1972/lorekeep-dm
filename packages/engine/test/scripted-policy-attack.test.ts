import { describe, expect, test } from 'vitest';
import { loadCatalog } from '../src/catalog-node.js';
import { resolveMonsterAttack } from '../src/scripted/policy.js';

const goblin = loadCatalog().get('monster', 'monster:goblin-minion')!;
const dagger = goblin.attacks![0]!;

describe('resolveMonsterAttack', () => {
  test('uses the goblin minion catalog attack id and damage type', () => {
    const result = resolveMonsterAttack(
      {
        id: goblin.id,
        team: 'foe',
        pos: { x: 0, y: 0 },
        hp: goblin.hp,
        ac: goblin.ac,
        speed: goblin.speed,
        attackBonus: dagger.toHit,
        damage: dagger.damage[0]!.dice,
        attacks: goblin.attacks,
      },
      {
        id: 'target',
        team: 'pc',
        pos: { x: 1, y: 0 },
        hp: 10,
        ac: 1,
        speed: 30,
        attackBonus: 0,
        damage: '1d4',
      },
      1,
    );

    expect(
      result.events?.find((event) => event.type === 'RollEvent')?.attackId,
    ).toBe('dagger');
    expect(
      result.events?.find((event) => event.type === 'HpChanged')?.damageType,
    ).toBe('piercing');
  });
});
