import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { processExport } from '../../src/accounts/export.js';
import { bootstrapped } from '../room/combatFixtures.js';

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

// Shape of a persisted room snapshot: Room.ts writes RoomStateSchema with gameState nested inside.
function roomState(seats: string[], gameState: Record<string, unknown>) {
  return {
    sessionId: randomUUID(),
    phase: 'lobby',
    seats: seats.map((accountId, i) => ({
      seatId: randomUUID(),
      accountId,
      displayName: `Seat ${i}`,
      presence: 'online',
    })),
    gameState,
    actionIds: [],
  };
}

async function insertSnapshot(sessionId: string, seq: number, state: unknown) {
  await db.query(
    'INSERT INTO snapshots(session_id,seq,state) VALUES($1,$2,$3::jsonb)',
    [sessionId, seq, JSON.stringify(state)],
  );
}

async function exportArchive(accountId: string) {
  let archive = '';
  await processExport(
    db,
    (await db.query('SELECT id FROM export_jobs WHERE account_id=$1', [accountId]))
      .rows[0].id,
    accountId,
    {
      put: async (_key, contents) => {
        archive = contents;
      },
      get: async () => archive,
      delete: async () => {},
    },
  );
  return archive;
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
    await insertSnapshot(
      mine,
      1,
      roomState([me], { recap: { recap: 'old' }, characters: { [me]: character } }),
    );
    await insertSnapshot(
      mine,
      2,
      roomState([me], {
        recap: { recap: 'Latest recap' },
        characters: { [me]: character },
        gameEngine: { actors: { [character.id]: character } },
      }),
    );
    await insertSnapshot(
      theirs,
      1,
      roomState([other], { recap: { recap: 'Their recap' } }),
    );
    await db.query(
      "INSERT INTO scene_summaries(session_id,scene_id,summary) VALUES($1,'scene-1','The ferry crossed the mere.')",
      [mine],
    );

    const archive = await exportArchive(me);
    const parsed = JSON.parse(archive);

    expect(parsed.characters).toEqual([
      expect.objectContaining({ sessionId: mine, character }),
    ]);
    expect(parsed.snapshots).toEqual([
      expect.objectContaining({
        sessionId: mine,
        seq: '2',
        state: {
          gameState: {
            recap: { recap: 'Latest recap' },
            characters: { [me]: character },
            gameEngine: { actors: { [character.id]: character } },
          },
        },
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

  it('omits co-players’ characters, seats and narrative from snapshots of rooms the player owns', async () => {
    const owner = await account(`owner-${randomUUID()}@example.test`);
    const coPlayer = await account(`seat-${randomUUID()}@example.test`);
    const room = randomUUID();
    const ownerCharacter = { id: 'c-owner', name: 'Brannoc', level: 2 };
    const coPlayerCharacter = { id: 'c-seat-b', name: 'Vesper', level: 3 };
    await db.query(
      "INSERT INTO sessions(id,owner_account_id,name,status,mode,character) VALUES($1,$2,'Shared','active','party',$3::jsonb)",
      [room, owner, JSON.stringify(ownerCharacter)],
    );
    await insertSnapshot(
      room,
      1,
      roomState([owner, coPlayer], {
        recap: { recap: 'The party crossed the mere.' },
        lastNarration: 'Vesper bargains with the ferryman.',
        characters: {
          [owner]: ownerCharacter,
          [coPlayer]: coPlayerCharacter,
        },
        gameEngine: {
          actors: {
            [ownerCharacter.id]: ownerCharacter,
            [coPlayerCharacter.id]: coPlayerCharacter,
          },
        },
      }),
    );

    const archive = await exportArchive(owner);
    const parsed = JSON.parse(archive);

    expect(parsed.snapshots).toEqual([
      expect.objectContaining({
        sessionId: room,
        state: {
          gameState: {
            characters: { [owner]: ownerCharacter },
            gameEngine: { actors: { [ownerCharacter.id]: ownerCharacter } },
          },
        },
      }),
    ]);
    expect(archive).toContain('Brannoc');
    expect(archive).not.toContain(coPlayer);
    expect(archive).not.toContain('Vesper');
    expect(archive).not.toContain('c-seat-b');
    expect(archive).not.toContain('Seat 1');
    expect(archive).not.toContain('The party crossed the mere.');
  });

  it('strips co-player entities, hp, combat and concentration from owned-room snapshots', async () => {
    const owner = await account(`combat-${randomUUID()}@example.test`);
    const coPlayer = await account(`combat-b-${randomUUID()}@example.test`);
    const room = randomUUID();
    const { game } = bootstrapped();
    const ownerHero = (game.characters as Record<string, { id: string }>)[
      '11111111-1111-4111-8111-111111111111'
    ]!;
    const vesper = { ...ownerHero, id: 'ent_vesper', name: 'Vesper' };
    const combatRoom = game.combatRoom as unknown as {
      entities: object[];
      combat: { initiative: object[]; resources: Record<string, object> };
    };
    await db.query(
      "INSERT INTO sessions(id,owner_account_id,name,status,mode,character) VALUES($1,$2,'Combat','active','party',$3::jsonb)",
      [room, owner, JSON.stringify(ownerHero)],
    );
    await insertSnapshot(
      room,
      1,
      roomState([owner, coPlayer], {
        ...game,
        characters: { [owner]: ownerHero, [coPlayer]: vesper },
        combatRoom: {
          ...combatRoom,
          entities: [
            ...combatRoom.entities,
            {
              id: 'ent_vesper',
              name: 'Vesper',
              kind: 'character',
              team: 'party',
              pos: { x: 2, y: 2 },
              size: 1,
              hp: 7,
              maxHp: 30,
              ac: 12,
              speed: 30,
            },
          ],
          combat: {
            ...combatRoom.combat,
            initiative: [
              ...combatRoom.combat.initiative,
              { entityId: 'ent_vesper', total: 18 },
            ],
            resources: {
              ...combatRoom.combat.resources,
              ent_vesper: {
                action: false,
                bonusAction: true,
                reaction: true,
                movementRemaining: 0,
              },
            },
          },
          concentration: { ent_vesper: 'spell:bless' },
        },
        combatActors: { [owner]: ownerHero.id, [coPlayer]: 'ent_vesper' },
        gameEngine: {
          ...(game.gameEngine as object),
          actors: { [ownerHero.id]: ownerHero, ent_vesper: vesper },
          hp: { [ownerHero.id]: 30, ent_vesper: 7 },
        },
        lastPlayerText: 'Vesper hurls a sphere of flame',
        unknownFutureKey: { note: 'Vesper secret' },
      }),
    );

    const archive = await exportArchive(owner);
    const parsed = JSON.parse(archive);

    expect(archive).toContain('Aria');
    expect(archive).not.toContain('ent_vesper');
    expect(archive).not.toContain('Vesper');
    expect(archive).not.toContain('spell:bless');
    expect(archive).not.toContain(coPlayer);
    expect(archive).not.toContain('combatRoom');
    expect(archive).not.toContain('combatActors');
    expect(archive).not.toContain('unknownFutureKey');
    expect(parsed.snapshots[0].state.gameState.gameEngine).toEqual({
      actors: { [ownerHero.id]: ownerHero },
    });
  });

  it('drops scene summaries and recap text of rooms where a co-player has a seat, now or in an earlier snapshot', async () => {
    const owner = await account(`narr-${randomUUID()}@example.test`);
    const former = await account(`former-${randomUUID()}@example.test`);
    const current = await account(`current-${randomUUID()}@example.test`);
    const character = { id: 'c-owner', name: 'Brannoc', level: 2 };
    const formerRoom = randomUUID();
    const currentRoom = randomUUID();
    await db.query(
      "INSERT INTO sessions(id,owner_account_id,name,status,mode,character) VALUES($1,$2,'Former','active','party',$3::jsonb),($4,$2,'Current','active','party',$3::jsonb)",
      [formerRoom, owner, JSON.stringify(character), currentRoom],
    );
    await insertSnapshot(
      formerRoom,
      1,
      roomState([owner, former], { recap: { recap: 'Former co-player narrative' } }),
    );
    await insertSnapshot(
      formerRoom,
      2,
      roomState([owner], { recap: { recap: 'Former co-player narrative' } }),
    );
    await insertSnapshot(
      currentRoom,
      1,
      roomState([owner, current], {
        recap: { recap: 'Current co-player narrative' },
      }),
    );
    await db.query(
      "INSERT INTO scene_summaries(session_id,scene_id,summary) VALUES($1,'scene-3','Former co-player narrative.'),($2,'scene-4','Current co-player narrative.')",
      [formerRoom, currentRoom],
    );

    const archive = await exportArchive(owner);
    const parsed = JSON.parse(archive);

    expect(parsed.summaries).toEqual([]);
    expect(archive).not.toContain('co-player narrative');
    expect(archive).not.toContain(former);
    expect(archive).not.toContain(current);
  });
});
