import { allowInputGate } from '../support/allowInputGate.js';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { hashPassword } from '../../src/accounts/password.js';
import { createSession } from '../../src/accounts/sessions.js';
import { setInvite } from '../../src/rooms/invites.js';
import { loadSeatedMatureOptOuts } from '../../src/safety/tierLoader.js';
import { computeContentTier } from '../../src/safety/tier.js';
import { Persistence } from '../../src/persistence/index.js';
import { RoomRegistry } from '../../src/room/registry.js';
import { SessionLease } from '../../src/room/lease.js';

const db = new Pool({ connectionString: process.env.DATABASE_URL });
afterAll(() => db.end());
const rooms = new RoomRegistry(
  new Persistence(db),
  new SessionLease(db),
  'mature-opt-out-test',
);

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

async function room(owner: string, tier?: string) {
  const id = randomUUID();
  await db.query(
    'INSERT INTO sessions(id,owner_account_id,name,content_tier) VALUES($1,$2,$3,$4)',
    [id, owner, 'Table', tier ?? 'standard'],
  );
  return id;
}

async function optOut(id: string) {
  return (
    await db.query<{ mature_opt_out: boolean }>(
      'SELECT mature_opt_out FROM accounts WHERE id=$1',
      [id],
    )
  ).rows[0]!.mature_opt_out;
}

describe('mature opt-out API', () => {
  it('lets a signed-in player set and clear their opt-out at any time', async () => {
    const player = await account();
    const token = await createSession(db, player, 'Test device');
    const app = createApp(
      db,
      { inputGate: allowInputGate, cookieSecret: 'test-secret' },
      { inputGate: allowInputGate },
    );
    const patch = (matureOptOut: unknown, cookie?: string) =>
      app.inject({
        method: 'PATCH',
        url: '/api/me/content-settings',
        remoteAddress: '10.9.0.1',
        headers: cookie ? { cookie } : {},
        payload: { matureOptOut },
      });

    expect((await patch(true)).statusCode).toBe(401);
    expect((await patch('yes', `sid=${token}`)).statusCode).toBe(400);

    const on = await patch(true, `sid=${token}`);
    expect(on.statusCode).toBe(200);
    expect(on.json()).toEqual({ matureOptOut: true });
    expect(await optOut(player)).toBe(true);

    expect((await patch(false, `sid=${token}`)).json()).toEqual({
      matureOptOut: false,
    });
    expect(await optOut(player)).toBe(false);
    await app.close();
  });

  it('sets the opt-out at join and seats the player with it', async () => {
    const host = await account();
    const player = await account();
    const token = await createSession(db, player, 'Test device');
    const sessionId = await room(host);
    const code = await setInvite(db, sessionId, host);
    const app = createApp(
      db,
      { inputGate: allowInputGate, cookieSecret: 'test-secret', rooms },
      { inputGate: allowInputGate },
    );

    const response = await app.inject({
      method: 'POST',
      url: `/api/join/${code}`,
      remoteAddress: '10.9.0.2',
      headers: { cookie: `sid=${token}` },
      payload: { matureOptOut: true },
    });

    expect(response.statusCode).toBe(200);
    expect(await optOut(player)).toBe(true);
    const seat = await db.query<{ matureOptOut: boolean }>(
      `SELECT payload->'matureOptOut' AS "matureOptOut" FROM events
        WHERE session_id=$1 AND type='SeatJoined' AND payload->>'accountId'=$2`,
      [sessionId, player],
    );
    expect(seat.rows[0]?.matureOptOut).toBe(true);
    await app.close();
  });

  it('lets the host lower the table tier but never change a player opt-out', async () => {
    const host = await account();
    const player = await account();
    const hostToken = await createSession(db, host, 'Host device');
    await db.query('UPDATE accounts SET mature_opt_out=true WHERE id=$1', [
      player,
    ]);
    const sessionId = await room(host, 'standard');
    const app = createApp(
      db,
      { inputGate: allowInputGate, cookieSecret: 'test-secret' },
      { inputGate: allowInputGate },
    );
    const put = (cookie: string | undefined, payload: unknown) =>
      app.inject({
        method: 'PATCH',
        url: `/api/sessions/${sessionId}/content-tier`,
        remoteAddress: '10.9.0.3',
        headers: cookie ? { cookie } : {},
        payload,
      });

    expect((await put(undefined, { tier: 'family' })).statusCode).toBe(401);
    const playerToken = await createSession(db, player, 'Player device');
    expect(
      (await put(`sid=${playerToken}`, { tier: 'family' })).statusCode,
    ).toBe(403);
    expect((await put(`sid=${hostToken}`, { tier: 'mature' })).statusCode).toBe(
      400,
    );

    const lowered = await put(`sid=${hostToken}`, {
      tier: 'family',
      matureOptOut: false,
    });
    expect(lowered.statusCode).toBe(200);
    expect(lowered.json()).toEqual({ tier: 'family' });
    const row = await db.query<{
      content_tier: string;
      host_tier_cap: string | null;
    }>('SELECT content_tier, host_tier_cap FROM sessions WHERE id=$1', [
      sessionId,
    ]);
    expect(row.rows[0]).toEqual({
      content_tier: 'standard',
      host_tier_cap: 'family',
    });
    const audit = await db.query<{ payload: unknown }>(
      `SELECT payload FROM events WHERE session_id=$1 AND type='HostTierCapChanged'`,
      [sessionId],
    );
    expect(audit.rows).toEqual([{ payload: { from: null, to: 'family' } }]);
    expect(await optOut(player)).toBe(true);
    await app.close();
  });

  it('clears the host cap with null and rejects a cross-origin PATCH', async () => {
    const host = await account();
    const hostToken = await createSession(db, host, 'Host device');
    const sessionId = await room(host);
    const app = createApp(
      db,
      { inputGate: allowInputGate, cookieSecret: 'test-secret' },
      { inputGate: allowInputGate },
    );
    const cookie = `sid=${hostToken}`;
    const put = (payload: unknown, origin?: string) =>
      app.inject({
        method: 'PATCH',
        url: `/api/sessions/${sessionId}/content-tier`,
        remoteAddress: '10.9.0.5',
        headers: origin ? { cookie, origin } : { cookie },
        payload,
      });

    expect(
      (await put({ tier: 'family' }, 'https://evil.example')).statusCode,
    ).toBe(403);
    expect((await put({ tier: 'family' })).statusCode).toBe(200);
    expect((await put({ tier: null })).json()).toEqual({ tier: null });
    const row = await db.query<{ host_tier_cap: string | null }>(
      'SELECT host_tier_cap FROM sessions WHERE id=$1',
      [sessionId],
    );
    expect(row.rows[0]?.host_tier_cap).toBeNull();
    await app.close();
  });

  it('rejects a cross-origin content-settings PATCH', async () => {
    const player = await account();
    const token = await createSession(db, player, 'Test device');
    const app = createApp(
      db,
      { inputGate: allowInputGate, cookieSecret: 'test-secret' },
      { inputGate: allowInputGate },
    );
    const response = await app.inject({
      method: 'PATCH',
      url: '/api/me/content-settings',
      remoteAddress: '10.9.0.6',
      headers: { cookie: `sid=${token}`, origin: 'https://evil.example' },
      payload: { matureOptOut: true },
    });
    expect(response.statusCode).toBe(403);
    expect(await optOut(player)).toBe(false);
    await app.close();
  });

  it('applies a player opt-out to the next narration tier', async () => {
    const host = await account();
    const player = await account();
    const sessionId = await room(host);
    await db.query(
      `INSERT INTO events(session_id,seq,turn_id,type,payload)
       VALUES($1,1,$2,'SeatJoined',$3)`,
      [sessionId, randomUUID(), JSON.stringify({ accountId: player })],
    );
    const tierInput = async () => ({
      seatedMatureOptOuts: await loadSeatedMatureOptOuts(db, sessionId),
      moderationVerified: true,
      endpointAllowsMature: true,
    });

    expect(computeContentTier(await tierInput())).toBe('mature');

    const token = await createSession(db, player, 'Test device');
    const app = createApp(
      db,
      { inputGate: allowInputGate, cookieSecret: 'test-secret' },
      { inputGate: allowInputGate },
    );
    await app.inject({
      method: 'PATCH',
      url: '/api/me/content-settings',
      remoteAddress: '10.9.0.4',
      headers: { cookie: `sid=${token}` },
      payload: { matureOptOut: true },
    });
    expect(computeContentTier(await tierInput())).toBe('standard');
    await app.close();
  });
});
