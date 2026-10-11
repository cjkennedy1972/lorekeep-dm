import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import WebSocket from 'ws';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/app.js';
import { installGateway } from '../../src/gateway/ws.js';
import { createSession } from '../../src/accounts/sessions.js';
import { Persistence } from '../../src/persistence/index.js';
import { RoomRegistry } from '../../src/room/registry.js';
import { SessionLease } from '../../src/room/lease.js';
import { Room } from '../../src/room/Room.js';
import { createInputGate, type InputGate } from '../../src/safety/inputGate.js';
import { purgeLogs } from '../../src/retention/jobs/logs.js';
import type { Moderator } from '../../src/safety/moderator.js';

const db = new Pool({ connectionString: process.env.DATABASE_URL });
const accounts = [randomUUID(), randomUUID()];
const sessionId = randomUUID();
const allowAll: Moderator = {
  moderate: async () => ({
    verdict: 'allow',
    category: 'none',
    source: 'judge',
    latencyMs: 0,
    unavailable: false,
  }),
} as never;

let gate: InputGate = { check: async () => true };
const app = createApp(db, { inputGate: { check: (i) => gate.check(i) } });
const rooms = new RoomRegistry(
  new Persistence(db),
  new SessionLease(db),
  'input-gate-test',
);
installGateway(app, db, rooms);
let base: string;
let tokens: string[];

function nextMessage(ws: WebSocket): Promise<{ type: string; payload: any }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('socket timeout')), 3000);
    ws.once('message', (data) => {
      clearTimeout(timer);
      resolve(JSON.parse(data.toString()));
    });
  });
}

async function openSocket(token: string) {
  const res = await fetch(`${base}/api/ws-ticket`, {
    method: 'POST',
    headers: { origin: base, cookie: `sid=${token}` },
  });
  const ticket = (await res.json()).ticket as string;
  const ws = new WebSocket(
    `${base.replace('http', 'ws')}/ws?ticket=${ticket}`,
    {
      origin: base,
    },
  );
  await nextMessage(ws);
  return ws;
}

function playerAction(text: string) {
  return JSON.stringify({
    actionId: randomUUID(),
    type: 'PlayerAction',
    payload: { text },
    lastSeq: 0,
  });
}

beforeAll(async () => {
  for (const [i, id] of accounts.entries())
    await db.query(
      `INSERT INTO accounts(id,email,password_hash,display_name,status,is_adult,age_checked_at,terms_version,terms_accepted_at) VALUES($1,$2,'hash',$3,'active',true,now(),'v1',now())`,
      [id, `${id}@example.test`, `Gate ${i}`],
    );
  await db.query('INSERT INTO sessions(id,owner_account_id) VALUES($1,$2)', [
    sessionId,
    accounts[0],
  ]);
  const room = await rooms.get(sessionId);
  await room.join(accounts[1], { send() {} }, 'Gate 1');
  await room.disconnect(accounts[1]);
  tokens = await Promise.all(
    accounts.map((id) => createSession(db, id, 'test')),
  );
  base = await app.listen({ host: '127.0.0.1', port: 0 });
});

afterAll(async () => {
  vi.restoreAllMocks();
  await rooms.drain();
  await app.close();
  await db.end();
});

describe('gateway input gate', () => {
  it('a rejected action never reaches the Room or the DM prompt', async () => {
    gate = { check: async ({ text }) => !text.includes('forbidden') };
    const submit = vi.spyOn(Room.prototype, 'submitAction');
    const ws = await openSocket(tokens[0]!);
    ws.send(playerAction('forbidden plan'));
    let reply = await nextMessage(ws);
    while (reply.type !== 'Error') reply = await nextMessage(ws);
    expect(reply).toMatchObject({
      type: 'Error',
      payload: { code: 'CONTENT_REJECTED' },
    });
    expect(JSON.stringify(reply)).not.toContain('forbidden');
    expect(submit).not.toHaveBeenCalled();
    ws.close();
    submit.mockRestore();
  });

  it('parallel submissions on one socket reach the Room in arrival order', async () => {
    gate = {
      check: ({ text }) =>
        new Promise((resolve) =>
          setTimeout(() => resolve(true), text.startsWith('slow') ? 150 : 0),
        ),
    };
    const submitted: string[] = [];
    const submit = vi
      .spyOn(Room.prototype, 'submitAction')
      .mockImplementation(async (_account, actionId) => {
        submitted.push(actionId);
        return true;
      });
    const ws = await openSocket(tokens[0]!);
    const first = JSON.parse(playerAction('slow first'));
    const second = JSON.parse(playerAction('fast second'));
    ws.send(JSON.stringify(first));
    ws.send(JSON.stringify(second));
    const deadline = Date.now() + 2000;
    while (submitted.length < 2 && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 10));
    expect(submitted).toEqual([first.actionId, second.actionId]);
    expect(submit).toHaveBeenCalledTimes(2);
    ws.close();
    submit.mockRestore();
  });
});

describe('moderation_log row', () => {
  it('expires 30 days after write, stores no raw text, and is purged once expired', async () => {
    const text = 'the 14yo girl had sex with the guard';
    const accountId = randomUUID();
    const gateOnly = createInputGate({
      db,
      moderator: allowAll,
      log: { warn: () => {} },
    });
    expect(
      await gateOnly.check({
        text,
        surface: 'player-action',
        accountId,
        sessionId,
      }),
    ).toBe(false);
    const row = (
      await db.query<{
        written_at: Date;
        expires_at: Date;
        raw: string;
      }>(
        `SELECT written_at, expires_at, to_jsonb(m)::text AS raw FROM moderation_log m WHERE account_id=$1`,
        [accountId],
      )
    ).rows[0]!;
    expect((row.expires_at.getTime() - row.written_at.getTime()) / 1000).toBe(
      30 * 86_400,
    );
    expect(row.raw).not.toContain('14yo');
    expect(row.raw).not.toContain('guard');

    const counts = await purgeLogs({
      db,
      now: new Date(row.expires_at.getTime() + 1000),
      log: () => {},
    } as never);
    expect(counts.moderationLog).toBeGreaterThanOrEqual(1);
    const left = await db.query(
      'SELECT 1 FROM moderation_log WHERE account_id=$1',
      [accountId],
    );
    expect(left.rowCount).toBe(0);
  });
});
