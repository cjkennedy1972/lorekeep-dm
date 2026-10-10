import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LocalObjectStore } from '../../src/storage/objectStore.js';
import { runSweep } from '../../src/retention/sweeper.js';
import { bootstrapped } from '../room/combatFixtures.js';

let db: Pool;
let dir: string;

const q = async (sql: string, p: unknown[] = []) =>
  (await db.query(sql, p)).rows;

beforeAll(async () => {
  db = new Pool({ connectionString: process.env.DATABASE_URL });
  dir = await mkdtemp(join(tmpdir(), 'combat-prune-'));
});
afterAll(async () => {
  await db.end();
  await rm(dir, { recursive: true, force: true });
});

describe('account deletion prunes combat state of the deleted character', () => {
  it('leaves no reference to the deleted character in the surviving combat snapshot', async () => {
    const gone = randomUUID();
    const heir = randomUUID();
    const session = randomUUID();
    await q(
      "INSERT INTO accounts(id,email,password_hash,display_name,status,is_adult,age_checked_at,terms_version,terms_accepted_at) VALUES($1,$2,'h','Gone','active',true,now(),'v1',now()),($3,$4,'h','Heir','active',true,now(),'v1',now())",
      [gone, `${gone}@example.test`, heir, `${heir}@example.test`],
    );
    try {
      const { game } = bootstrapped(7);
      const sheet = Object.values(
        game.characters as Record<string, { id: string }>,
      )[0]!;
      const charId = sheet.id;
      const combat = game.combatRoom!;
      expect(
        combat.entities.some((e) => e.id === charId && e.team === 'party'),
      ).toBe(true);
      const goblin = combat.entities.find((e) => e.team === 'enemies')!.id;
      const partyEntity = combat.entities.find((e) => e.id === charId)!;
      const state = {
        ...game,
        characters: { [gone]: sheet },
        combatActors: { [gone]: charId },
        combatRoom: {
          ...combat,
          entities: [
            ...combat.entities,
            { ...partyEntity, id: 'ent_other', name: 'Other' },
          ],
          combat: {
            ...combat.combat,
            initiative: [
              ...combat.combat.initiative,
              { entityId: 'ent_other', total: 1 },
            ],
            resources: {
              ...combat.combat.resources,
              ent_other: combat.combat.resources[charId]!,
            },
          },
          concentration: { [goblin]: charId },
          pendingReaction: {
            reactionId: 'r-goblin',
            entityId: goblin,
            trigger: 'move',
            moverId: goblin,
            deadlineAt: Date.now() + 60_000,
          },
          engineReactions: {
            'r-goblin': {
              reactionId: 'r-goblin',
              moverId: goblin,
              hostileId: charId,
              remainingPath: [],
              mode: 'normal',
            },
          },
        },
      };

      await q(
        'INSERT INTO sessions(id,owner_account_id,name,adventure_id,character_id) VALUES($1,$2,$3,$4,$5)',
        [
          session,
          gone,
          'Prune',
          'adventure:01-hollow-under-marrowfell',
          charId,
        ],
      );
      await q(
        "INSERT INTO events(session_id,seq,turn_id,type,payload) VALUES($1,1,$2,'SeatJoined',$3),($1,2,$4,'SeatJoined',$5)",
        [
          session,
          randomUUID(),
          {
            seatId: randomUUID(),
            accountId: heir,
            displayName: 'Heir',
            presence: 'offline',
          },
          randomUUID(),
          {
            seatId: randomUUID(),
            accountId: gone,
            displayName: 'Gone',
            presence: 'offline',
          },
        ],
      );
      await q('INSERT INTO snapshots(session_id,seq,state) VALUES($1,2,$2)', [
        session,
        state,
      ]);

      await q(
        "UPDATE accounts SET status='deleting', deletion_requested_at=now() WHERE id=$1",
        [gone],
      );
      await runSweep(db, { store: new LocalObjectStore(dir), log: () => {} });

      const [snap] = await q(
        'SELECT state FROM snapshots WHERE session_id=$1',
        [session],
      );
      expect(snap, 'session must survive via heir handoff').toBeDefined();
      const leaks: string[] = [];
      const walk = (v: unknown, p: string) => {
        if (typeof v === 'string' && v.includes(charId))
          leaks.push(`${p}=${v}`);
        else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${p}[${i}]`));
        else if (v && typeof v === 'object')
          for (const [k, x] of Object.entries(v)) walk(x, `${p}.${k}`);
      };
      walk(snap.state, '');
      expect(leaks).toEqual([]);
      const room = (
        snap.state as {
          combatRoom: {
            entities: { id: string }[];
            engineReactions?: Record<
              string,
              { hostileId: string; moverId: string }
            >;
          };
        }
      ).combatRoom;
      const live = new Set(room.entities.map((e) => e.id));
      for (const r of Object.values(room.engineReactions ?? {})) {
        expect(live.has(r.hostileId)).toBe(true);
        expect(live.has(r.moverId)).toBe(true);
      }
    } finally {
      await q('SELECT purge_session($1)', [session]);
      await q('DELETE FROM accounts WHERE id = ANY($1)', [[gone, heir]]);
    }
  });
});
