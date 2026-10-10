import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { LocalObjectStore } from '../../src/storage/objectStore.js';
import { runSweep } from '../../src/retention/sweeper.js';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
afterAll(() => pool.end());
const log = () => {};
const q = async (sql: string, p: unknown[] = []) =>
  (await pool.query(sql, p)).rows;

const SECRETS = ['SecretName', 'SecretText', 'SecretNarr', 'SecretSheet'];

async function account(status: string, name: string) {
  const id = randomUUID();
  await q(
    "INSERT INTO accounts(id,email,password_hash,display_name,status,is_adult,age_checked_at,terms_version,terms_accepted_at,deletion_requested_at) VALUES($1,$2,'h',$3,$4,true,now(),'v1',now(),now())",
    [id, `${id}@example.test`, name, status],
  );
  return id;
}

function sheet(id: string, name: string) {
  return {
    id,
    name,
    hp: 7,
    backstory: name === 'SecretName' ? 'SecretSheet' : 'plain',
  };
}

describe('account deletion completeness', () => {
  it('scrubs the deleted player from every room surface and keeps the heir room loadable', async () => {
    const gone = await account('deleting', 'SecretName');
    const friend = await account('active', 'Friend');
    const session = randomUUID();
    const charId = randomUUID();
    const friendCharId = randomUUID();
    const seatId = randomUUID();
    const friendSeatId = randomUUID();
    const clarifyAction = randomUUID();
    const deadCharActor = { id: charId, name: 'SecretName' };

    await q(
      'INSERT INTO sessions(id,owner_account_id,character_id,character) VALUES($1,$2,$3,$4)',
      [session, gone, charId, sheet(charId, 'SecretName')],
    );

    const gameState = {
      characters: {
        [gone]: sheet(charId, 'SecretName'),
        [friend]: sheet(friendCharId, 'Friend'),
      },
      gameEngine: {
        actors: {
          [charId]: deadCharActor,
          [friendCharId]: { id: friendCharId, name: 'Friend' },
        },
      },
      combatActors: { [gone]: { id: charId, name: 'SecretName' } },
      lastPlayerText: 'SecretText',
      openClarifications: {
        [clarifyAction]: {
          accountId: gone,
          playerName: 'SecretName',
          text: 'SecretText',
          question: 'Which door?',
        },
      },
      failForward: { accountId: gone, narrative: 'SecretNarr' },
      checkpoint: {
        gameState: {
          characters: { [gone]: sheet(charId, 'SecretName') },
          lastPlayerText: 'SecretText',
        },
      },
    };
    const seats = [
      {
        seatId,
        accountId: gone,
        displayName: 'SecretName',
        presence: 'offline',
      },
      {
        seatId: friendSeatId,
        accountId: friend,
        displayName: 'Friend',
        presence: 'online',
      },
    ];

    const events: [number, string, Record<string, unknown>][] = [
      [
        1,
        'SeatJoined',
        {
          seatId,
          accountId: gone,
          displayName: 'SecretName',
          presence: 'offline',
        },
      ],
      [
        2,
        'SeatJoined',
        {
          seatId: friendSeatId,
          accountId: friend,
          displayName: 'Friend',
          presence: 'online',
        },
      ],
      [3, 'GameStateCommitted', { gameState }],
      [
        4,
        'ClarificationRequested',
        {
          actionId: clarifyAction,
          accountId: gone,
          playerName: 'SecretName',
          text: 'SecretText',
          question: 'Which door?',
        },
      ],
      [
        5,
        'DeathSaveRolled',
        {
          accountId: gone,
          die: 3,
          state: { characters: { [gone]: sheet(charId, 'SecretName') } },
        },
      ],
      [6, 'CharacterDied', { accountId: gone, entityId: charId }],
      [7, 'ResurrectionOrNewCharacterOffered', { accountId: gone }],
      [8, 'FailForwardChosen', { accountId: gone, narrative: 'SecretNarr' }],
    ];
    for (const [seq, type, payload] of events) {
      await q(
        'INSERT INTO events(session_id,seq,turn_id,type,payload) VALUES($1,$2,$1,$3,$4)',
        [session, seq, type, payload],
      );
    }
    await q('INSERT INTO snapshots(session_id,seq,state) VALUES($1,8,$2)', [
      session,
      {
        sessionId: session,
        seats,
        gameState,
        actionIds: [],
        openClarifications: gameState.openClarifications,
      },
    ]);

    const store = new LocalObjectStore(
      await mkdtemp(join(tmpdir(), 'acct-del-')),
    );
    await runSweep(pool, { store, log });

    expect(await q('SELECT id FROM accounts WHERE id=$1', [gone])).toHaveLength(
      0,
    );
    const [session_] = await q(
      'SELECT owner_account_id, character, character_id FROM sessions WHERE id=$1',
      [session],
    );
    expect(session_.owner_account_id).toBe(friend);
    expect(session_.character).toBeNull();
    expect(session_.character_id).toBeNull();

    const dump = JSON.stringify([
      await q('SELECT payload FROM events WHERE session_id=$1', [session]),
      await q('SELECT state FROM snapshots WHERE session_id=$1', [session]),
      await q('SELECT character, character_id FROM sessions WHERE id=$1', [
        session,
      ]),
    ]);
    expect(dump).not.toContain(gone);
    expect(dump).not.toContain(charId);
    for (const secret of SECRETS) expect(dump).not.toContain(secret);

    const [snap] = await q('SELECT state FROM snapshots WHERE session_id=$1', [
      session,
    ]);
    const state = snap.state as {
      gameState: Record<string, unknown>;
      seats: { accountId: string; displayName: string }[];
    };
    expect(state.gameState.characters).toEqual({
      [friend]: sheet(friendCharId, 'Friend'),
    });
    expect(state.gameState.lastPlayerText).toBeUndefined();
    expect(
      state.seats.find((s) => s.displayName === 'Deleted player'),
    ).toBeDefined();
  });
});
