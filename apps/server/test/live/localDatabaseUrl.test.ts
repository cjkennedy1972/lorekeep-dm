import { expect, it } from 'vitest';
import { isLocalDatabaseUrl } from './localDatabaseUrl.js';

it('refuses a non-local host even when a local host appears in the query', () => {
  expect(
    isLocalDatabaseUrl('postgres://u:***@evil.example/db?x=@localhost/'),
  ).toBe(false);
});
