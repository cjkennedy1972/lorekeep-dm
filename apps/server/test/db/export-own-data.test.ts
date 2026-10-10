import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { processExport } from '../../src/accounts/export.js';

const db = new Pool({ connectionString: process.env.DATABASE_URL });
afterAll(() => db.end());

async function account(email: string) {
  const id = randomUUID();
  await db.query(
    `INSERT INTO accounts(id,email,password_hash,display_name,status,is_adult,age_checked_at,terms_version,terms_accepted_at)
     VALUES($1,$2,'$argon2id$secret-hash','Player','active',true,now(),'t',now())`,
    [id, email],
  );
  await db.query(
    "INSERT INTO export_jobs(id,account_id,status) VALUES($1,$1,'pending')",
    [id],
  );
  return id;
}

describe('account export carries the player’s own gameplay data', () => {
  it('includes owned characters, latest snapshots and scene summaries, and nothing of another account', async () => {
    const me = await account(`me-${randomUUID()}@example.test`);
    const other = await account(`other-${randomUUID()}@example.test`);
    const mine = randomUUID();
    const theirs = randomUUID();
    const character = { id: 'c-1', name: 'Brannoc', level: 2 };
    await db.query(
      "INSERT INTO sessions(id,owner_account_id,name,status,mode,character) VALUES($1,$2,'Mine','active','solo',$3::jsonb)",
      [mine, me, JSON.stringify(character)],
    );
    await db.query(
      "INSERT INTO sessions(id,owner_account_id,name,status,mode,character) VALUES($1,$2,'Theirs','active','solo',$3::jsonb)",
      [theirs, other, JSON.stringify({ id: 'c-2', name: 'Vesper' })],
    );
    await db.query(
      'INSERT INTO snapshots(session_id,seq,state) VALUES($1,1,\'{"recap":{"recap":"old"}}\'),($1,2,\'{"recap":{"recap":"Latest recap"}}\')',
      [mine],
    );
    await db.query(
      'INSERT INTO snapshots(session_id,seq,state) VALUES($1,1,\'{"recap":{"recap":"Their recap"}}\')',
      [theirs],
    );
    await db.query(
      "INSERT INTO scene_summaries(session_id,scene_id,summary) VALUES($1,'scene-1','The ferry crossed the mere.')",
      [mine],
    );

    let archive = '';
    await processExport(
      db,
      (await db.query('SELECT id FROM export_jobs WHERE account_id=$1', [me]))
        .rows[0].id,
      me,
      {
        put: async (_key, contents) => {
          archive = contents;
        },
        get: async () => archive,
        delete: async () => {},
      },
    );
    const parsed = JSON.parse(archive);

    expect(parsed.characters).toEqual([
      expect.objectContaining({ sessionId: mine, character }),
    ]);
    expect(parsed.snapshots).toEqual([
      expect.objectContaining({
        sessionId: mine,
        seq: '2',
        state: { recap: { recap: 'Latest recap' } },
      }),
    ]);
    expect(parsed.summaries).toEqual([
      expect.objectContaining({
        sessionId: mine,
        sceneId: 'scene-1',
        summary: 'The ferry crossed the mere.',
      }),
    ]);
    expect(archive).not.toContain(other.slice(0, 8));
    expect(archive).not.toContain('Vesper');
    expect(archive).not.toContain('Their recap');
    expect(archive).not.toContain('argon2id');
  });
});
