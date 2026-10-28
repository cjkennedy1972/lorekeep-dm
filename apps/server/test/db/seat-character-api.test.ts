import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { quickBuild } from '@game/rules-engine';
import { CharacterSchema } from '@game/schema';
import { createApp } from '../../src/app.js';
import { createSession } from '../../src/accounts/sessions.js';
import { loadCatalog } from '@game/rules-engine/catalog-node';
import { SeatCharacterRepository } from '../../src/persistence/seatCharacters.js';

const db = new Pool({ connectionString: process.env.DATABASE_URL });
afterAll(() => db.end());

async function account() {
  const id = randomUUID();
  await db.query(
    `INSERT INTO accounts(id,email,password_hash,display_name,status,is_adult,age_checked_at,terms_version,terms_accepted_at)
     VALUES($1,$2,'hash','Player','active',true,now(),'test',now())`,
    [id, `${id}@example.test`],
  );
  return id;
}

describe('account-owned character API', () => {
  it('rejects wizard armor that the class is not proficient in', async () => {
    const owner = await account();
    const ownerToken = await createSession(db, owner, 'test');
    const app = createApp(db, { cookieSecret: 'test-secret' });
    const character = CharacterSchema.omit({ id: true }).parse(
      quickBuild(loadCatalog(), 'class:wizard', 0x36, 1).character,
    );
    character.equipment.push({
      itemId: 'equipment:plate-armor',
      qty: 1,
      equipped: true,
    });
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/me/characters',
        headers: { cookie: `sid=${ownerToken}` },
        payload: { character },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({
        code: 'INVALID_CHARACTER',
        message: 'Character could not be saved.',
      });
    } finally {
      await app.close();
    }
  });

  it('lists only picker fields and creates/updates characters with revision checks', async () => {
    const owner = await account();
    const stranger = await account();
    const ownerToken = await createSession(db, owner, 'test');
    const strangerToken = await createSession(db, stranger, 'test');
    const app = createApp(db, { cookieSecret: 'test-secret' });
    const headers = { cookie: `sid=${ownerToken}` };
    const character = CharacterSchema.omit({ id: true }).parse(
      quickBuild(loadCatalog(), undefined, 0x35, 1).character,
    );
    const post = (token: string, payload: unknown) =>
      app.inject({
        method: 'POST',
        url: '/api/me/characters',
        headers: { cookie: `sid=${token}` },
        payload,
      });
    try {
      const created = await post(ownerToken, { character });
      expect(created.statusCode).toBe(201);
      const createdItem = created.json();
      expect(Object.keys(createdItem).sort()).toEqual(
        ['id', 'revision', 'name', 'classId', 'speciesId', 'level'].sort(),
      );
      expect(createdItem).toMatchObject({
        revision: 1,
        name: character.name,
        classId: character.classId,
        speciesId: character.speciesId,
        level: character.level,
      });
      expect(createdItem.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      );
      const characterId = createdItem.id as string;
      const characters = new SeatCharacterRepository(db);
      expect(
        await characters.validateLateJoinSelection(owner, characterId, 1),
      ).toEqual({
        name: character.name,
        classId: character.classId,
        level: character.level,
      });
      const unavailable = await Promise.allSettled([
        characters.validateLateJoinSelection(stranger, characterId, 1),
        characters.validateLateJoinSelection(stranger, randomUUID(), 1),
      ]);
      expect(unavailable.map((result) => result.status)).toEqual([
        'rejected',
        'rejected',
      ]);
      expect(
        unavailable.map((result) =>
          result.status === 'rejected'
            ? (result.reason as Error & { code?: string }).code
            : undefined,
        ),
      ).toEqual(['NOT_FOUND', 'NOT_FOUND']);

      const clientId = await post(ownerToken, {
        character: { ...character, id: randomUUID() },
      });
      expect(clientId.statusCode).toBe(400);
      expect(clientId.json().code).toBe('INVALID_CHARACTER');

      const listed = await app.inject({
        method: 'GET',
        url: '/api/me/characters',
        headers,
      });
      expect(listed.statusCode).toBe(200);
      const response = listed.json();
      expect(Object.keys(response).sort()).toEqual(['characters']);
      const listedCharacters = response.characters;
      expect(listedCharacters).toHaveLength(1);
      expect(Object.keys(listedCharacters[0]).sort()).toEqual(
        ['classId', 'id', 'level', 'name', 'revision', 'speciesId'].sort(),
      );
      expect(listedCharacters[0]).toEqual({
        id: characterId,
        revision: 1,
        name: character.name,
        classId: character.classId,
        speciesId: character.speciesId,
        level: character.level,
      });

      const updatedCharacter = { ...character, name: 'Updated picker name' };
      const updated = await post(ownerToken, {
        id: characterId,
        character: updatedCharacter,
        expectedRevision: 1,
      });
      expect(updated.statusCode).toBe(200);
      expect(updated.json()).toEqual({
        id: characterId,
        revision: 2,
        name: 'Updated picker name',
        classId: character.classId,
        speciesId: character.speciesId,
        level: character.level,
      });
      expect(
        (
          await post(ownerToken, {
            id: characterId,
            character,
            expectedRevision: 1,
          })
        ).statusCode,
      ).toBe(409);

      const foreign = await post(strangerToken, {
        id: characterId,
        character,
        expectedRevision: 1,
      });
      const unknown = await post(strangerToken, {
        id: randomUUID(),
        character,
        expectedRevision: 1,
      });
      expect(foreign.statusCode).toBe(404);
      expect(foreign.statusCode).toBe(unknown.statusCode);
      expect(foreign.json()).toEqual(unknown.json());
      const strangerList = await app.inject({
        method: 'GET',
        url: '/api/me/characters',
        headers: { cookie: `sid=${strangerToken}` },
      });
      expect(strangerList.json()).toEqual({ characters: [] });

      for (let i = 0; i < 7; i++) await post(ownerToken, { character });
      expect((await post(ownerToken, { character })).statusCode).toBe(429);
    } finally {
      await app.close();
      await db.query('DELETE FROM accounts WHERE id=ANY($1)', [
        [owner, stranger],
      ]);
    }
  });

  it('rejects unauthenticated, invalid, and cross-origin requests', async () => {
    const owner = await account();
    const token = await createSession(db, owner, 'test');
    const app = createApp(db, { cookieSecret: 'test-secret' });
    try {
      const noSession = await app.inject({
        method: 'GET',
        url: '/api/me/characters',
      });
      expect(noSession.statusCode).toBe(401);
      expect(noSession.json().code).toBe('UNAUTHENTICATED');

      const badOrigin = await app.inject({
        method: 'POST',
        url: '/api/me/characters',
        headers: {
          cookie: `sid=${token}`,
          origin: 'https://evil.example',
          host: 'game.example.test',
        },
        payload: {},
      });
      expect(badOrigin.statusCode).toBe(403);
      expect(badOrigin.json().code).toBe('BAD_ORIGIN');

      const invalid = await app.inject({
        method: 'POST',
        url: '/api/me/characters',
        headers: { cookie: `sid=${token}` },
        payload: {},
      });
      expect(invalid.statusCode).toBe(400);
      expect(invalid.json().code).toBe('INVALID_CHARACTER');
    } finally {
      await app.close();
      await db.query('DELETE FROM accounts WHERE id=$1', [owner]);
    }
  });

  it('rejects inactive accounts on GET and reports an inactive write race', async () => {
    const owner = await account();
    const token = await createSession(db, owner, 'test');
    const normalApp = createApp(db, { cookieSecret: 'test-secret' });
    try {
      await db.query("UPDATE accounts SET status='deleted' WHERE id=$1", [
        owner,
      ]);
      const inactiveGet = await normalApp.inject({
        method: 'GET',
        url: '/api/me/characters',
        headers: { cookie: `sid=${token}` },
      });
      expect(inactiveGet.statusCode).toBe(401);
      expect(inactiveGet.json().code).toBe('UNAUTHENTICATED');
    } finally {
      await normalApp.close();
      await db.query("UPDATE accounts SET status='active' WHERE id=$1", [
        owner,
      ]);
    }

    let deactivated = false;
    const raceDb = {
      ...db,
      query: async (...args: Parameters<typeof db.query>) => {
        const result = await db.query(...args);
        if (
          !deactivated &&
          typeof args[0] === 'string' &&
          args[0].includes('UPDATE auth_sessions s SET last_active_at')
        ) {
          deactivated = true;
          await db.query("UPDATE accounts SET status='deleted' WHERE id=$1", [
            owner,
          ]);
        }
        return result;
      },
      connect: db.connect.bind(db),
    } as unknown as Pool;
    const raceApp = createApp(raceDb, { cookieSecret: 'test-secret' });
    try {
      const character = CharacterSchema.omit({ id: true }).parse(
        quickBuild(loadCatalog(), undefined, 0x35, 1).character,
      );
      const inactivePost = await raceApp.inject({
        method: 'POST',
        url: '/api/me/characters',
        headers: { cookie: `sid=${token}` },
        payload: { character },
      });
      expect(deactivated).toBe(true);
      expect(inactivePost.statusCode).toBe(403);
      expect(inactivePost.json().code).toBe('ACCOUNT_INACTIVE');
    } finally {
      await raceApp.close();
      await db.query("UPDATE accounts SET status='active' WHERE id=$1", [
        owner,
      ]);
      await db.query('DELETE FROM accounts WHERE id=$1', [owner]);
    }
  });
});
