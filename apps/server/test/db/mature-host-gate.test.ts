import { allowInputGate } from '../support/allowInputGate.js';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { hashPassword } from '../../src/accounts/password.js';
import { createSession } from '../../src/accounts/sessions.js';
import { loadContentTierState } from '../../src/safety/tierLoader.js';

const db = new Pool({ connectionString: process.env.DATABASE_URL });
afterAll(() => db.end());

const PASSWORD = 'correct-password-1';

async function account() {
  const id = randomUUID();
  await db.query(
    `INSERT INTO accounts(id,email,password_hash,display_name,status,is_adult,age_checked_at,terms_version,terms_accepted_at)
     VALUES($1,$2,$3,'Player','active',true,now(),'t',now())`,
    [id, `${id}@example.test`, await hashPassword(PASSWORD)],
  );
  return id;
}

async function room(owner: string) {
  const id = randomUUID();
  await db.query(
    `INSERT INTO sessions(id,owner_account_id,name,content_tier,moderation_verified)
     VALUES($1,$2,'Table','standard',true)`,
    [id, owner],
  );
  return id;
}

async function seat(sessionId: string, accountId: string) {
  await db.query(
    `INSERT INTO events(session_id,seq,turn_id,type,payload)
     VALUES($1,(SELECT COALESCE(MAX(seq),0)+1 FROM events WHERE session_id=$1),$2,'SeatJoined',$3)`,
    [sessionId, randomUUID(), JSON.stringify({ accountId })],
  );
}

async function setOptOut(accountId: string, value: boolean) {
  await db.query('UPDATE accounts SET mature_opt_out=$2 WHERE id=$1', [
    accountId,
    value,
  ]);
}

async function storedCap(sessionId: string) {
  return (
    await db.query<{ host_tier_cap: string | null }>(
      'SELECT host_tier_cap FROM sessions WHERE id=$1',
      [sessionId],
    )
  ).rows[0]?.host_tier_cap;
}

function appFor(endpointAllowsMature: boolean) {
  return createApp(db, {
    inputGate: allowInputGate,
    cookieSecret: 'test-secret',
    endpointAllowsMature,
    liveDmAllowlistOnly: false,
  });
}

async function hostPut(
  app: ReturnType<typeof createApp>,
  token: string,
  sessionId: string,
  tier: unknown,
) {
  return app.inject({
    method: 'PATCH',
    url: `/api/sessions/${sessionId}/content-tier`,
    remoteAddress: '10.9.1.1',
    headers: { cookie: `sid=${token}` },
    payload: { tier },
  });
}

describe('host raise to mature (ADR-016 gate)', () => {
  it('allows mature when the endpoint allows it and every seat is an adult without opt-out', async () => {
    const host = await account();
    const player = await account();
    const sessionId = await room(host);
    await seat(sessionId, player);
    const token = await createSession(db, host, 'Host device');
    const app = appFor(true);

    const res = await hostPut(app, token, sessionId, 'mature');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ tier: 'mature' });
    expect(await storedCap(sessionId)).toBeNull();
    expect((await loadContentTierState(db, sessionId, true)).tier).toBe(
      'mature',
    );
    await app.close();
  });

  it('blocks mature when a seat has no adult account row (fails closed)', async () => {
    // accounts_is_adult_check forbids is_adult=false, so an under-18 row cannot exist (ADR-015);
    // a seat whose account is missing is the closest reachable non-adult case.
    const host = await account();
    const adult = await account();
    const sessionId = await room(host);
    await seat(sessionId, adult);
    await seat(sessionId, randomUUID());
    const token = await createSession(db, host, 'Host device');
    const app = appFor(true);

    const res = await hostPut(app, token, sessionId, 'mature');
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'MATURE_NOT_ALLOWED' });
    expect((await loadContentTierState(db, sessionId, true)).tier).toBe(
      'standard',
    );
    await app.close();
  });

  it('blocks mature when one seated player has opted out', async () => {
    const host = await account();
    const adult = await account();
    const optedOut = await account();
    await setOptOut(optedOut, true);
    const sessionId = await room(host);
    await seat(sessionId, adult);
    await seat(sessionId, optedOut);
    const token = await createSession(db, host, 'Host device');
    const app = appFor(true);

    const res = await hostPut(app, token, sessionId, 'mature');
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'MATURE_NOT_ALLOWED' });
    expect(await storedCap(sessionId)).toBeNull();
    await app.close();
  });

  it('blocks mature when the endpoint does not allow it', async () => {
    const host = await account();
    const sessionId = await room(host);
    await seat(sessionId, await account());
    const token = await createSession(db, host, 'Host device');
    const app = appFor(false);

    expect((await hostPut(app, token, sessionId, 'mature')).statusCode).toBe(
      409,
    );
    await app.close();
  });

  it('lets a later player opt-out lower the effective tier from mature to standard', async () => {
    const host = await account();
    const player = await account();
    const sessionId = await room(host);
    await seat(sessionId, player);
    const hostToken = await createSession(db, host, 'Host device');
    const playerToken = await createSession(db, player, 'Player device');
    const app = appFor(true);

    expect(
      (await hostPut(app, hostToken, sessionId, 'mature')).statusCode,
    ).toBe(200);
    expect((await loadContentTierState(db, sessionId, true)).tier).toBe(
      'mature',
    );

    await app.inject({
      method: 'PATCH',
      url: '/api/me/content-settings',
      remoteAddress: '10.9.1.2',
      headers: { cookie: `sid=${playerToken}` },
      payload: { matureOptOut: true },
    });
    expect((await loadContentTierState(db, sessionId, true)).tier).toBe(
      'standard',
    );
    await app.close();
  });
});
