import { randomUUID } from 'node:crypto';
import { CharacterSchema } from '@game/schema';

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

/** Body for POST /api/me/characters: exactly one key, `character`, holding the sheet without an id. */
const CreateCharacterBody = CharacterSchema.omit({ id: true });

/** Validates a create body the way the real route does. Returns the sheet, or undefined when it must be rejected with INVALID_CHARACTER. */
export function parseCreateBody(body: unknown) {
  if (typeof body !== 'object' || body === null || Array.isArray(body))
    return undefined;
  // An update (expectedRevision) is not mocked; the web client never sends one.
  const keys = Object.keys(body);
  if (keys.length !== 1 || keys[0] !== 'character') return undefined;
  const sheet: unknown = (body as { character: unknown }).character;
  if (typeof sheet === 'object' && sheet !== null && 'id' in sheet)
    return undefined;
  const parsed = CreateCharacterBody.safeParse(sheet);
  return parsed.success ? parsed.data : undefined;
}

const WRITE_WINDOW_MS = 60_000;
const WRITES_PER_WINDOW = 10;
const writes = new Map<string, { count: number; resetAt: number }>();

/** Mirrors the real route's per-account write budget: the 11th valid write inside a minute is refused. */
export function allowWrite(accountId: string, now = Date.now()): boolean {
  const window = writes.get(accountId);
  if (!window || now >= window.resetAt) {
    writes.set(accountId, { count: 1, resetAt: now + WRITE_WINDOW_MS });
    return true;
  }
  window.count += 1;
  return window.count <= WRITES_PER_WINDOW;
}

/** Creates a character with a server-generated id and revision 1, appended to the account's list. */
export function createCharacter(
  accountId: string,
  sheet: Omit<MockCharacter, 'id' | 'accountId' | 'revision'>,
): MockCharacter {
  const list = charactersFor(accountId);
  const character: MockCharacter = {
    id: randomUUID(),
    accountId,
    name: sheet.name,
    classId: sheet.classId,
    speciesId: sheet.speciesId,
    level: sheet.level,
    revision: 1,
  };
  byId.set(character.id, character);
  list.push(character);
  return character;
}

/** Test driver: bumps a character's revision so a previously loaded binding choice goes stale. */
export function bumpRevision(id: string): MockCharacter | undefined {
  const character = byId.get(id);
  if (character) character.revision += 1;
  return character;
}
