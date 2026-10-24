import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { quickBuild } from '@game/rules-engine';
import { createApp } from '../../src/app.js';
import { createSession } from '../../src/accounts/sessions.js';
import { loadCatalog } from '@game/rules-engine/catalog-node';

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
  it('lists only picker fields and creates/updates characters with revision checks', async () => {
    const owner = await account();
    const stranger = await account();
    const ownerToken = await createSession(db, owner, 'test');
    const strangerToken = await createSession(db, stranger, 'test');
    const app = createApp(db, { cookieSecret: 'test-secret' });
    const headers = { cookie: `sid=${ownerToken}` };
    const character = {
      ...quickBuild(loadCatalog(), undefined, 0x35, 1).character,
      id: randomUUID(),
    };
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
      expect(created.json()).toEqual({ id: character.id, revision: 1 });

      const listed = await app.inject({
        method: 'GET',
        url: '/api/me/characters',
        headers,
      });
      expect(listed.statusCode).toBe(200);
      expect(listed.json()).toEqual([
        {
          id: character.id,
          revision: 1,
          name: character.name,
          classId: character.classId,
          speciesId: character.speciesId,
          level: character.level,
        },
      ]);

      const updatedCharacter = { ...character, name: 'Updated picker name' };
      const updated = await post(ownerToken, {
        character: updatedCharacter,
        expectedRevision: 1,
      });
      expect(updated.statusCode).toBe(200);
      expect(updated.json()).toEqual({ id: character.id, revision: 2 });
      expect(
        (await post(ownerToken, { character, expectedRevision: 1 })).statusCode,
      ).toBe(409);

      const foreign = await post(strangerToken, { character });
      expect(foreign.statusCode).toBe(409);
      const strangerList = await app.inject({
        method: 'GET',
        url: '/api/me/characters',
        headers: { cookie: `sid=${strangerToken}` },
      });
      expect(strangerList.json()).toEqual([]);

      for (let i = 0; i < 7; i++) await post(ownerToken, { character });
      expect((await post(ownerToken, { character })).statusCode).toBe(429);
    } finally {
      await app.close();
      await db.query('DELETE FROM accounts WHERE id=ANY($1)', [
        [owner, stranger],
      ]);
    }
  });
});
