import { randomUUID } from 'node:crypto';

/** Owned-character record for the mock; the list response mirrors GET /api/me/characters (ids, not display strings). */
export interface MockCharacter {
  id: string;
  accountId: string;
  name: string;
  classId: string;
  speciesId: string;
  level: number;
  revision: number;
}

const byAccount = new Map<string, MockCharacter[]>();
const byId = new Map<string, MockCharacter>();

const SEED = [
  {
    name: 'Aldric Vane',
    classId: 'class:fighter',
    speciesId: 'species:human',
    level: 3,
  },
  {
    name: 'Brenna Holt',
    classId: 'class:wizard',
    speciesId: 'species:elf',
    level: 3,
  },
] as const;

/** Lazily seeds two characters per account so a fresh signup has something to bind. */
export function charactersFor(accountId: string): MockCharacter[] {
  let list = byAccount.get(accountId);
  if (!list) {
    list = SEED.map((seed) => {
      const character: MockCharacter = {
        id: randomUUID(),
        accountId,
        ...seed,
        revision: 1,
      };
      byId.set(character.id, character);
      return character;
    });
    byAccount.set(accountId, list);
  }
  return list;
}

export function characterById(id: string): MockCharacter | undefined {
  return byId.get(id);
}

/** Test driver: bumps a character's revision so a previously loaded binding choice goes stale. */
export function bumpRevision(id: string): MockCharacter | undefined {
  const character = byId.get(id);
  if (character) character.revision += 1;
  return character;
}
