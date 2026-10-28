import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCombatRuntime } from '../../src/room/combat.js';
import { deleteTestSessions } from './testCleanup.js';
import { bootstrapped, hero } from '../room/combatFixtures.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL required');

const accountIds: string[] = [];
const sessionIds: string[] = [];
let db: Pool;

const caster = {
  ...hero,
  spellsKnown: [
    'spell:expeditious-retreat',
    'spell:mage-armor',
    'spell:true-strike',
  ],
  spellsPrepared: [
    'spell:expeditious-retreat',
    'spell:mage-armor',
    'spell:true-strike',
  ],
};

async function setupTable() {
  const accountId = randomUUID();
  await db.query(
    `INSERT INTO accounts(id,email,password_hash,display_name,status,is_adult,age_checked_at,terms_version,terms_accepted_at) VALUES($1,$2,'hash','Aria','active',true,now(),'v1',now())`,
    [accountId, `${accountId}@example.test`],
  );
  accountIds.push(accountId);
  const sessionId = randomUUID();
  await db.query(
    'INSERT INTO sessions(id,owner_account_id,name,character) VALUES($1,$2,$3,$4)',
    [sessionId, accountId, 'Combat spell pairing', JSON.stringify(caster)],
  );
  await db.query(
    `INSERT INTO events(session_id,seq,turn_id,type,payload) VALUES($1,1,$1,'SeatJoined',$2)`,
    [sessionId, JSON.stringify({ accountId, displayName: 'Aria' })],
  );
  sessionIds.push(sessionId);
  return { combat: bootstrapped().state };
}

beforeAll(async () => {
  db = new Pool({ connectionString: databaseUrl });
});

afterAll(async () => {
  await deleteTestSessions(db, sessionIds);
  for (const id of accountIds)
    await db.query('DELETE FROM accounts WHERE id=$1', [id]);
  await db.end();
});

describe('bonus-action spell pairing through combat commands', () => {
  it('rejects a bonus spell after a command action spell', async () => {
    const table = await setupTable();
    const runtime = createCombatRuntime();
    const commandAction = runtime.execute(
      table.combat,
      'ent_aria',
      {
        command: 'cast',
        spellId: 'spell:mage-armor',
        slotLevel: 1,
        target: { kind: 'self' },
      },
      { character: caster },
    );
    if ('code' in commandAction) throw new Error(commandAction.message);
    expect(commandAction.state.combat.resources.ent_aria?.action).toBe(false);

    expect(
      runtime.execute(
        commandAction.state,
        'ent_aria',
        {
          command: 'cast',
          spellId: 'spell:expeditious-retreat',
          slotLevel: 1,
          target: { kind: 'self' },
        },
        { character: caster },
      ),
    ).toMatchObject({ code: 'COMMAND_REJECTED' });
  });

  it('allows a cantrip after a bonus spell but rejects another leveled spell', async () => {
    const table = await setupTable();
    const runtime = createCombatRuntime();
    const commandBonus = runtime.execute(
      table.combat,
      'ent_aria',
      {
        command: 'cast',
        spellId: 'spell:expeditious-retreat',
        slotLevel: 1,
        target: { kind: 'self' },
      },
      { character: caster },
    );
    if ('code' in commandBonus) throw new Error(commandBonus.message);
    expect(
      commandBonus.state.combat.resources.ent_aria?.bonusActionSpellCast,
    ).toBe(true);

    expect(
      runtime.execute(
        commandBonus.state,
        'ent_aria',
        {
          command: 'cast',
          spellId: 'spell:mage-armor',
          slotLevel: 1,
          target: { kind: 'self' },
        },
        { character: caster },
      ),
    ).toMatchObject({ code: 'COMMAND_REJECTED' });

    const cantrip = runtime.execute(
      commandBonus.state,
      'ent_aria',
      {
        command: 'cast',
        spellId: 'spell:true-strike',
        slotLevel: 0,
        target: { kind: 'self' },
      },
      { character: caster },
    );
    expect(cantrip).not.toMatchObject({ code: 'COMMAND_REJECTED' });
    if (!('code' in cantrip))
      expect(cantrip.state.combat.resources.ent_aria?.action).toBe(false);
  });
});
