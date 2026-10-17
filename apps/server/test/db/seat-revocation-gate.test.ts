import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { quickBuild } from '@game/rules-engine';
import { loadCatalog } from '@game/rules-engine/catalog-node';
import type { LlmAdapter } from '../../src/llm/adapter.js';
import { ProductionSoloTurnRunner } from '../../src/room/productionTurnRunner.js';
import { deleteTestSessions } from './testCleanup.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL required');
const ADVENTURE = 'adventure:01-hollow-under-marrowfell';
let db: Pool;
let dir: string;
const accountIds: string[] = [];
const sessionIds: string[] = [];

beforeAll(async () => {
  db = new Pool({ connectionString: databaseUrl });
  dir = await mkdtemp(join(tmpdir(), 'seat-revocation-'));
});
afterAll(async () => {
  await deleteTestSessions(db, sessionIds);
  for (const id of accountIds)
    await db.query('DELETE FROM accounts WHERE id=$1', [id]);
  await db.end();
  await rm(dir, { recursive: true, force: true });
});

describe('solo turn seat gate after SeatRevoked', () => {
  it('rejects an account whose historical SeatJoined was revoked', async () => {
    const catalog = loadCatalog();
    const own = {
      ...quickBuild(catalog, 'class:cleric', 0x2a, 1).character,
      id: randomUUID(),
    };
    const accountId = randomUUID();
    const seatId = randomUUID();
    await db.query(
      `INSERT INTO accounts(id,email,password_hash,display_name,status,is_adult,age_checked_at,terms_version,terms_accepted_at) VALUES($1,$2,'hash','Revoked','active',true,now(),'v1',now())`,
      [accountId, `${accountId}@example.test`],
    );
    accountIds.push(accountId);
    await db.query(
      `INSERT INTO catalog_snapshots(catalog_version,entries) VALUES($1,$2::jsonb) ON CONFLICT (catalog_version) DO NOTHING`,
      [catalog.catalogVersion, JSON.stringify(catalog.entries)],
    );
    const sessionId = randomUUID();
    await db.query(
      `INSERT INTO sessions(id,owner_account_id,name,status,mode,adventure_id,difficulty,catalog_version,character_id,character)
       VALUES($1,$2,'Revoked seat','active','solo',$3,'moderate',$4,$5,$6::jsonb)`,
      [
        sessionId,
        accountId,
        ADVENTURE,
        catalog.catalogVersion,
        own.id,
        JSON.stringify(own),
      ],
    );
    await db.query(
      `INSERT INTO events(session_id,seq,turn_id,type,payload)
       VALUES($1,1,$1,'SeatJoined',$2),($1,2,$1,'SeatRevoked',$3)`,
      [
        sessionId,
        JSON.stringify({ seatId, accountId, displayName: 'Revoked' }),
        JSON.stringify({ seatId, accountId }),
      ],
    );
    sessionIds.push(sessionId);

    const adapter = {
      complete: async function* () {},
    } as unknown as LlmAdapter;
    const runner = new ProductionSoloTurnRunner(
      db,
      undefined,
      'record',
      join(dir, 'revoked.ndjson'),
      adapter,
    );
    await expect(
      runner.run(
        {
          sessionId,
          accountId,
          actionId: randomUUID(),
          text: 'I try to act after leaving.',
          state: {
            sceneId: 'scene-marowfell-well',
            adventureId: ADVENTURE,
            characters: { [accountId]: own },
          },
        },
        () => undefined,
      ),
    ).rejects.toThrow('Player is not seated at this table');
  });
});
