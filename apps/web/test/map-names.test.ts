import { describe, expect, it } from 'vitest';
import {
  createEntityNamer,
  initialsOf,
  nameFromCatalogId,
} from '../src/features/map/names.js';

describe('entity display names', () => {
  it('turns catalog ids into readable labels without the prefix or the id number', () => {
    expect(nameFromCatalogId('ent_goblin-minion_1')).toBe('Goblin Minion');
    expect(nameFromCatalogId('ent_goblin-minion_12')).toBe('Goblin Minion');
    expect(nameFromCatalogId('ent_ogre')).toBe('Ogre');
    expect(nameFromCatalogId('ent_7')).toBe('Creature');
  });

  it('never turns a UUID or hex record id into a label, so no screen prints it', () => {
    const uuid = '3f2a9c1e-7b4d-4e8a-9f10-2c5d6e7f8a9b';
    expect(nameFromCatalogId(`ent_${uuid}`)).toBe('Combatant');
    expect(nameFromCatalogId(`ent_${uuid}_2`)).toBe('Combatant');
    expect(nameFromCatalogId('ent_3f2a9c1e7b4d')).toBe('Combatant');
    // Ordinary monster ids that happen to use hex letters keep their names.
    expect(nameFromCatalogId('ent_bad-cafe')).toBe('Bad Cafe');
    expect(nameFromCatalogId('ent_goblin-minion_1')).toBe('Goblin Minion');
  });

  it('strips an embedded UUID from a catalog id and keeps the readable word', () => {
    const uuid = '3f2a9c1e-7b4d-4e8a-9f10-2c5d6e7f8a9b';
    expect(nameFromCatalogId(`ent_seat_${uuid}`)).toBe('Seat');
    expect(nameFromCatalogId(`ent_goblin_${uuid}`)).toBe('Goblin');
    expect(nameFromCatalogId(`ent_goblin-minion_${uuid}_2`)).toBe(
      'Goblin Minion',
    );
    expect(nameFromCatalogId('ent_goblin')).toBe('Goblin');
  });

  it('handles uppercase UUIDs and uppercase hex runs the same way', () => {
    const uuid = '3F2A9C1E-7B4D-4E8A-9F10-2C5D6E7F8A9B';
    expect(nameFromCatalogId(`ent_${uuid}`)).toBe('Combatant');
    expect(nameFromCatalogId(`ent_seat_${uuid}`)).toBe('Seat');
    expect(nameFromCatalogId('ent_seat_3F2A9C1E7B4D')).toBe('Seat');
  });

  it('numbers twins whose embedded UUIDs differ, without showing any fragment', () => {
    const namer = createEntityNamer({
      entities: [
        {
          id: 'ent_goblin_3f2a9c1e-7b4d-4e8a-9f10-2c5d6e7f8a9b',
          kind: 'monster',
        },
        {
          id: 'ent_goblin_0b1c2d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e',
          kind: 'monster',
        },
      ],
    });
    expect(namer('ent_goblin_3f2a9c1e-7b4d-4e8a-9f10-2c5d6e7f8a9b')).toBe(
      'Goblin 1',
    );
    expect(namer('ent_goblin_0b1c2d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e')).toBe(
      'Goblin 2',
    );
  });

  it('labels UUID combatants by visible order, so twins still stay apart', () => {
    const namer = createEntityNamer({
      entities: [
        { id: 'ent_3f2a9c1e-7b4d-4e8a-9f10-2c5d6e7f8a9b', kind: 'monster' },
        { id: 'ent_0b1c2d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e', kind: 'monster' },
      ],
    });
    expect(namer('ent_3f2a9c1e-7b4d-4e8a-9f10-2c5d6e7f8a9b')).toBe(
      'Combatant 1',
    );
    expect(namer('ent_0b1c2d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e')).toBe(
      'Combatant 2',
    );
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
        { seatId: 's1', displayName: 'Chris' },
        { seatId: 's2', displayName: 'Dana' },
      ],
      characters: { s1: { id: 'c1', name: 'Aria' } },
    });
    expect(namer('ent_seat_s1')).toBe('Aria');
    expect(namer('ent_seat_s2')).toBe('Dana');
    expect(namer('ent_seat_s3')).toBe('Party member 3');
    expect(namer('ent_goblin-minion_1')).toBe('Goblin Minion');
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

  it('numbers visible twins in order, so an id gap never reveals a hidden sibling', () => {
    // ent_goblin-minion_1 is hidden from this viewer and never reaches the namer.
    const namer = createEntityNamer({
      entities: [
        { id: 'ent_goblin-minion_2', kind: 'monster', name: 'Goblin Minion' },
        { id: 'ent_goblin-minion_3', kind: 'monster', name: 'Goblin Minion' },
      ],
    });
    expect(namer('ent_goblin-minion_2')).toBe('Goblin Minion 1');
    expect(namer('ent_goblin-minion_3')).toBe('Goblin Minion 2');
  });

  it('numbers catalog-id twins in visible order, ignoring the id numbers and any gap', () => {
    // ent_goblin-minion_1, _3 and _4 are hidden from this viewer; the ids 2 and 5 must not show.
    const namer = createEntityNamer({
      entities: [
        { id: 'ent_goblin-minion_2', kind: 'monster' },
        { id: 'ent_goblin-minion_5', kind: 'monster' },
      ],
    });
    expect(namer('ent_goblin-minion_2')).toBe('Goblin Minion 1');
    expect(namer('ent_goblin-minion_5')).toBe('Goblin Minion 2');
  });

  it('leaves a lone entity unnumbered even when its catalog id ends in a digit', () => {
    const namer = createEntityNamer({
      entities: [{ id: 'ent_goblin-minion_3', kind: 'monster' }],
    });
    expect(namer('ent_goblin-minion_3')).toBe('Goblin Minion');
  });

  it('numbers named and catalog-id twins by visible order when they share a name', () => {
    const namer = createEntityNamer({
      entities: [
        { id: 'ent_goblin-minion_7', kind: 'monster', name: 'Goblin Minion' },
        { id: 'ent_goblin-minion_9', kind: 'monster' },
      ],
    });
    expect(namer('ent_goblin-minion_7')).toBe('Goblin Minion 1');
    expect(namer('ent_goblin-minion_9')).toBe('Goblin Minion 2');
  });

  it('numbers unnamed fallback creatures from visible order, not from their ids', () => {
    const namer = createEntityNamer({
      entities: [
        { id: 'ent_7', kind: 'monster' },
        { id: 'ent_12', kind: 'monster' },
      ],
    });
    expect(namer('ent_7')).toBe('Creature 1');
    expect(namer('ent_12')).toBe('Creature 2');
    const lone = createEntityNamer({
      entities: [{ id: 'ent_42', kind: 'monster' }],
    });
    expect(lone('ent_42')).toBe('Creature');
  });

  it('names a solo character entity by its character id', () => {
    const namer = createEntityNamer({
      entities: [{ id: 'c-9', kind: 'character' }],
      characters: { acct: { id: 'c-9', name: 'Mira' } },
    });
    expect(namer('c-9')).toBe('Mira');
  });
});
