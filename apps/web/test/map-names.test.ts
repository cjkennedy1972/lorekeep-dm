import { describe, expect, it } from 'vitest';
import {
  createEntityNamer,
  initialsOf,
  nameFromCatalogId,
} from '../src/features/map/names.js';

describe('entity display names', () => {
  it('turns catalog ids into readable labels without the prefix', () => {
    expect(nameFromCatalogId('ent_goblin-minion_1')).toBe('Goblin Minion 1');
    expect(nameFromCatalogId('ent_ogre')).toBe('Ogre');
    expect(nameFromCatalogId('ent_7')).toBe('Creature 7');
  });

  it('makes two-letter initials and keeps numbered twins apart', () => {
    expect(initialsOf('Aria')).toBe('A');
    expect(initialsOf('Mira Stone')).toBe('MS');
    expect(initialsOf('Goblin Minion 2')).toBe('G2');
    expect(initialsOf('Hero 70')).toBe('H');
    expect(initialsOf('   ')).toBe('?');
  });

  it('prefers entity name, then bound character, then seat name, then a derived label', () => {
    const namer = createEntityNamer({
      entities: [
        { id: 'ent_seat_s1', kind: 'character' },
        { id: 'ent_seat_s2', kind: 'character' },
        { id: 'ent_seat_s3', kind: 'character' },
        { id: 'ent_goblin-minion_1', kind: 'monster' },
        { id: 'ent_boss', kind: 'monster', name: 'Skarn the Pale' },
      ],
      seats: [
        { seatId: 's1', accountId: 'a1', displayName: 'Chris' },
        { seatId: 's2', accountId: 'a2', displayName: 'Dana' },
      ],
      characters: { a1: { id: 'c1', name: 'Aria' } },
    });
    expect(namer('ent_seat_s1')).toBe('Aria');
    expect(namer('ent_seat_s2')).toBe('Dana');
    expect(namer('ent_seat_s3')).toBe('Party member 3');
    expect(namer('ent_goblin-minion_1')).toBe('Goblin Minion 1');
    expect(namer('ent_boss')).toBe('Skarn the Pale');
  });

  it('numbers entities that share a name', () => {
    const namer = createEntityNamer({
      entities: [
        { id: 'ent_goblin-minion_1', kind: 'monster', name: 'Goblin Minion' },
        { id: 'ent_goblin-minion_2', kind: 'monster', name: 'Goblin Minion' },
      ],
    });
    expect(namer('ent_goblin-minion_1')).toBe('Goblin Minion 1');
    expect(namer('ent_goblin-minion_2')).toBe('Goblin Minion 2');
  });

  it('names a solo character entity by its character id', () => {
    const namer = createEntityNamer({
      entities: [{ id: 'c-9', kind: 'character' }],
      characters: { acct: { id: 'c-9', name: 'Mira' } },
    });
    expect(namer('c-9')).toBe('Mira');
  });
});
