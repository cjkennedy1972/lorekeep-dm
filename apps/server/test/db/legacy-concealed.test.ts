import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Persistence } from '../../src/persistence/index.js';
import { RoomRegistry } from '../../src/room/registry.js';
import { SessionLease } from '../../src/room/lease.js';
import { concealedEntities } from '../../src/room/eventVisibility.js';
import { buildLateJoinRecap } from '../../src/dm/lateJoinRecap.js';
import { buildResumeRecap } from '../../src/dm/recap.js';

let db: Pool;
let rooms: RoomRegistry;
const owner = randomUUID();
beforeAll(async () => {
  db = new Pool({ connectionString: process.env.DATABASE_URL });
  rooms = new RoomRegistry(
    new Persistence(db),
    new SessionLease(db),
    'legacy-concealed',
  );
  await db.query(
    `INSERT INTO accounts(id,email,password_hash,display_name,status,is_adult,age_checked_at,terms_version,terms_accepted_at)
     VALUES($1,$2,'x','Owner','active',true,now(),'t',now())`,
    [owner, `${owner}@example.test`],
  );
});
afterAll(async () => {
  await rooms.drain();
  await db.end();
});

/** A session whose hidden goblin was torn down before this deploy: the snapshot has no `concealed` key. */
async function legacySession(snapshotGame: Record<string, unknown>) {
  const id = randomUUID();
  await db.query(
    "INSERT INTO sessions(id,owner_account_id,name,adventure_id) VALUES($1,$2,'Legacy','adventure:01-hollow-under-marrowfell')",
    [id, owner],
  );
  const commit = (seq: number, gameState: unknown) =>
    db.query(
      "INSERT INTO events(session_id,seq,turn_id,type,payload) VALUES($1,$2,$3,'GameStateCommitted',$4)",
      [id, seq, randomUUID(), JSON.stringify({ gameState })],
    );
  await commit(1, {
    combatRoom: {
      entities: [{ id: 'ent_gob', name: 'Gribble', hidden: true }],
    },
  });
  await commit(2, { sceneId: 'later' });
  await db.query(
    'INSERT INTO snapshots(session_id,seq,state) VALUES($1,2,$2)',
    [
      id,
      JSON.stringify({
        sessionId: id,
        phase: 'lobby',
        seats: [],
        gameState: snapshotGame,
      }),
    ],
  );
  return id;
}

describe('pre-deploy snapshots rebuild the concealed record once', () => {
  it('a snapshot without `concealed` regains the torn-down hidden goblin on load', async () => {
    const id = await legacySession({ sceneId: 'later' });
    const room = await rooms.get(id);
    const hidden = concealedEntities(room.state.gameState);
    expect(hidden).toEqual([{ id: 'ent_gob', name: 'Gribble' }]);

    const rows = {
      query: async (sql: string) => ({
        rows: sql.includes('FROM scene_summaries')
          ? [{ text: 'Scene a: Gribble the goblin ambushed the party.' }]
          : [],
      }),
    } as never;
    const allow = { moderate: async () => ({ verdict: 'allow' }) } as never;
    const late = await buildLateJoinRecap({
      db: rows,
      sessionId: id,
      moderator: allow,
      tier: 'standard',
      tableLines: [],
      hidden,
    });
    const resume = await buildResumeRecap({ db: rows, sessionId: id, hidden });
    expect(late.recap).not.toMatch(/Gribble|ent_gob/);
    expect(resume.recap).not.toMatch(/Gribble|ent_gob/);
    expect(JSON.stringify(room.clientState())).not.toMatch(/Gribble|concealed/);
  });

  it('an already-marked snapshot is not rescanned', async () => {
    const id = await legacySession({ sceneId: 'later', concealed: [] });
    const room = await rooms.get(id);
    expect(concealedEntities(room.state.gameState)).toEqual([]);
  });
});
