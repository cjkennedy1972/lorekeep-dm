import { expect, test } from 'vitest';
import { nameFromCatalogId } from './names.js';

test('a seat id with a truncated record id reads as the seat, never a hex fragment', () => {
  expect(nameFromCatalogId('ent_seat_3f2a9c1e-7b4d')).toBe('Seat');
  expect(nameFromCatalogId('ent_seat_3f2a9c1e')).toBe('Seat');
});

test('a truncated record id with no readable word reads as Combatant', () => {
  expect(nameFromCatalogId('ent_3f2a9c1e-7b4d')).toBe('Combatant');
});

test('a catalog id keeps its readable name and drops a truncated record suffix', () => {
  expect(nameFromCatalogId('ent_goblin-minion_1')).toBe('Goblin Minion');
  expect(nameFromCatalogId('ent_goblin_3f2a9c1e-7b4d')).toBe('Goblin');
});
