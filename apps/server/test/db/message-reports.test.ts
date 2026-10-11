import Fastify from 'fastify';
import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSession } from '../../src/accounts/sessions.js';
import { registerOperatorRoutes } from '../../src/routes/operator.js';
import { registerReportRoutes } from '../../src/routes/reports.js';
import { createTestDatabase, type TestDatabase } from './testDb.js';

const HOST = 'http://lorekeep.test';

async function migrate(database: TestDatabase) {
  const names = (await readdir(new URL('../../migrations/', import.meta.url)))
    .filter((f) => f.endsWith('.sql'))
    .sort();
  for (const name of names)
    await database.pool.query(
      await readFile(
        new URL(`../../migrations/${name}`, import.meta.url),
        'utf8',
      ),
    );
}

describe('message reports', () => {
  let database: TestDatabase;
  let host: string;
  let seated: string;
  let outsider: string;
  let operator: string;
  let sessionId: string;
  let hostCookie: string;
  let seatedCookie: string;
  let outsiderCookie: string;
  let operatorCookie: string;

  const pool = () => database.pool;
  const seatAccount = async (name: string) => {
    const id = randomUUID();
    await pool().query(
      `INSERT INTO accounts(id,email,password_hash,display_name,status,is_adult,age_checked_at,terms_version,terms_accepted_at)
       VALUES($1,$2,'x',$3,'active',true,now(),'v1',now())`,
      [id, `${id}@example.test`, name],
    );
    return id;
  };
  const cookieFor = async (accountId: string) =>
    `sid=${await createSession(pool(), accountId, 'test', new Date(Date.now() + 86_400_000))}`;

  let seq = 0;
  const addEvent = async (type: string, payload: Record<string, unknown>) => {
    seq += 1;
    await pool().query(
      'INSERT INTO events(session_id,seq,turn_id,type,payload) VALUES($1,$2,$3,$4,$5)',
      [sessionId, seq, randomUUID(), type, JSON.stringify(payload)],
    );
    return seq;
  };

  beforeEach(async () => {
    database = await createTestDatabase({ extraSearchPath: ['public'] });
    await migrate(database);
    host = await seatAccount('Host');
    seated = await seatAccount('Seated');
    outsider = await seatAccount('Outsider');
    operator = await seatAccount('Operator');
    hostCookie = await cookieFor(host);
    seatedCookie = await cookieFor(seated);
    outsiderCookie = await cookieFor(outsider);
    operatorCookie = await cookieFor(operator);
    sessionId = randomUUID();
    await pool().query(
      "INSERT INTO sessions(id,owner_account_id,name) VALUES($1,$2,'Table')",
      [sessionId, host],
    );
  });

  afterEach(async () => {
    await database.close();
  });

  async function transcript() {
    seq = 0;
    await pool().query('DELETE FROM events WHERE session_id=$1', [sessionId]);
    await addEvent('SeatJoined', { accountId: host, displayName: 'Host' });
    await addEvent('SeatJoined', { accountId: seated, displayName: 'Seated' });
    for (let i = 0; i < 12; i++)
      await addEvent('NarrationCompleted', {
        actionId: `dm-${i}`,
        narration: `Narration ${i}`,
      });
    return addEvent('ActionAccepted', {
      accountId: seated,
      playerName: 'Seated',
      text: 'I hit the goblin.',
      actionId: 'a1',
    });
  }

  function app() {
    const server = Fastify();
    registerReportRoutes(server, pool());
    registerOperatorRoutes(server, pool(), async (id) => id === operator, {
      egress: {} as never,
    });
    return server;
  }

  const post = (
    server: ReturnType<typeof app>,
    cookie: string,
    body: unknown,
    origin = HOST,
  ) =>
    server.inject({
      method: 'POST',
      url: `/api/rooms/${sessionId}/reports`,
      headers: { cookie, origin, host: 'lorekeep.test' },
      payload: body as object,
    });

  it('lets a seated member report a message and stores a bounded snapshot without other account ids', async () => {
    const ref = await transcript();
    const server = app();
    const res = await post(server, hostCookie, {
      messageRef: ref,
      category: 'harassment',
      reason: 'Insulting.',
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ received: true });
    const row = (
      await pool().query(
        'SELECT reporter_account_id,author_account_id,context,status,expires_at>now() AS live,expires_at-created_at AS life FROM message_reports',
      )
    ).rows[0];
    expect(row.reporter_account_id).toBe(host);
    expect(row.author_account_id).toBe(seated);
    expect(row.status).toBe('open');
    expect(row.live).toBe(true);
    expect(row.life.days).toBe(90);
    expect(row.context.length).toBe(11);
    expect(row.context.at(-1)).toMatchObject({
      seq: ref,
      playerName: 'Player A',
      text: 'I hit the goblin.',
    });
    const dump = JSON.stringify(row.context);
    expect(dump).toContain('_authorId');
    expect(dump).not.toContain(host);
    expect(dump).not.toContain(operator);
  });

  it('truncates long transcript text inside the snapshot', async () => {
    await transcript();
    const big = await addEvent('NarrationCompleted', {
      narration: 'x'.repeat(5000),
    });
    const res = await post(app(), hostCookie, {
      messageRef: big,
      category: 'other',
    });
    expect(res.statusCode).toBe(202);
    const context = (await pool().query('SELECT context FROM message_reports'))
      .rows[0].context as Array<{ narration?: string }>;
    expect(context.at(-1)?.narration?.length).toBeLessThanOrEqual(500);
  });

  it('keeps the snapshot valid when the 500-character cut falls inside an emoji', async () => {
    await transcript();
    const big = await addEvent('ActionAccepted', {
      accountId: seated,
      playerName: 'Seated',
      text: `${'a'.repeat(499)}😀tail`,
      actionId: 'a2',
    });
    const res = await post(app(), hostCookie, {
      messageRef: big,
      category: 'other',
    });
    expect(res.statusCode).toBe(202);
    const context = (await pool().query('SELECT context FROM message_reports'))
      .rows[0].context as Array<{ text?: string }>;
    expect(context.at(-1)?.text).toBe(`${'a'.repeat(499)}😀`);
  });

  it('replaces player names in the snapshot with seat labels', async () => {
    const ref = await transcript();
    await post(app(), hostCookie, { messageRef: ref, category: 'other' });
    const context = (await pool().query('SELECT context FROM message_reports'))
      .rows[0].context as Array<{ playerName?: string }>;
    expect(context.at(-1)?.playerName).toBe('Player A');
    expect(JSON.stringify(context)).not.toContain('Seated');
    expect(JSON.stringify(context)).not.toContain('Host');
  });

  it('moves open reports to a 90-day window and reviewed ones to 30 days from the review', async () => {
    const ref = await transcript();
    const server = app();
    await post(server, hostCookie, { messageRef: ref, category: 'other' });
    const id = (await pool().query('SELECT id FROM message_reports')).rows[0]
      .id;
    const url = `/api/operator/reports/${id}`;
    const headers = {
      cookie: operatorCookie,
      origin: HOST,
      host: 'lorekeep.test',
    };
    await server.inject({
      method: 'PATCH',
      url,
      headers,
      payload: { status: 'dismissed' },
    });
    expect(
      (
        await pool().query(
          "SELECT expires_at - reviewed_at = interval '30 days' AS ok FROM message_reports WHERE id=$1",
          [id],
        )
      ).rows[0].ok,
    ).toBe(true);
    await server.inject({
      method: 'PATCH',
      url,
      headers,
      payload: { status: 'open' },
    });
    expect(
      (
        await pool().query(
          "SELECT expires_at - now() > interval '89 days' AS ok FROM message_reports WHERE id=$1",
          [id],
        )
      ).rows[0].ok,
    ).toBe(true);
  });

  it('rejects status changes outside the review state machine', async () => {
    const ref = await transcript();
    const server = app();
    await post(server, hostCookie, { messageRef: ref, category: 'other' });
    const id = (await pool().query('SELECT id FROM message_reports')).rows[0]
      .id;
    const url = `/api/operator/reports/${id}`;
    const headers = {
      cookie: operatorCookie,
      origin: HOST,
      host: 'lorekeep.test',
    };
    const patch = (status: string) =>
      server.inject({ method: 'PATCH', url, headers, payload: { status } });
    expect((await patch('open')).statusCode).toBe(409);
    expect((await patch('reviewed')).statusCode).toBe(200);
    expect((await patch('open')).statusCode).toBe(200);
    expect((await patch('actioned')).statusCode).toBe(200);
    const blocked = await patch('dismissed');
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().code).toBe('INVALID_TRANSITION');
    expect((await patch('reviewed')).statusCode).toBe(200);
    expect(
      (
        await pool().query(
          'SELECT count(*)::int AS n FROM message_report_audit WHERE report_id=$1',
          [id],
        )
      ).rows[0].n,
    ).toBe(4);
  });

  it('rejects offsets past the cap on the operator list', async () => {
    await transcript();
    const res = await app().inject({
      method: 'GET',
      url: '/api/operator/reports?offset=10001',
      headers: { cookie: operatorCookie },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects non-members without revealing the table', async () => {
    const ref = await transcript();
    const res = await post(app(), outsiderCookie, {
      messageRef: ref,
      category: 'other',
    });
    expect(res.statusCode).toBe(404);
    expect(
      (await pool().query('SELECT count(*)::int AS n FROM message_reports'))
        .rows[0].n,
    ).toBe(0);
  });

  it('rejects reporting your own message', async () => {
    const ref = await transcript();
    const res = await post(app(), seatedCookie, {
      messageRef: ref,
      category: 'other',
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('OWN_MESSAGE');
    const own = await post(app(), hostCookie, {
      messageRef: ref,
      category: 'other',
    });
    expect(own.statusCode).toBe(202);
  });

  it('is idempotent for the same reporter and message', async () => {
    const ref = await transcript();
    const server = app();
    const first = await post(server, hostCookie, {
      messageRef: ref,
      category: 'hate',
    });
    const second = await post(server, hostCookie, {
      messageRef: ref,
      category: 'hate',
    });
    expect(second.statusCode).toBe(first.statusCode);
    expect(second.json()).toEqual(first.json());
    expect(
      (await pool().query('SELECT count(*)::int AS n FROM message_reports'))
        .rows[0].n,
    ).toBe(1);
  });

  it('rate-limits reports per account', async () => {
    await transcript();
    const server = app();
    const statuses: number[] = [];
    for (let ref = 3; ref <= 13; ref++)
      statuses.push(
        (await post(server, hostCookie, { messageRef: ref, category: 'other' }))
          .statusCode,
      );
    expect(statuses.slice(0, 10).every((s) => s === 202)).toBe(true);
    expect(statuses[10]).toBe(429);
  });

  it('validates the body and unknown messages', async () => {
    await transcript();
    const server = app();
    expect(
      (await post(server, hostCookie, { messageRef: 3, category: 'nope' }))
        .statusCode,
    ).toBe(400);
    expect(
      (
        await post(server, hostCookie, {
          messageRef: 3,
          category: 'other',
          reason: 'x'.repeat(501),
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await post(server, hostCookie, {
          messageRef: 3,
          category: 'other',
          reason: '😀'.repeat(300),
        })
      ).statusCode,
    ).toBe(202);
    expect(
      (
        await post(server, hostCookie, {
          messageRef: 3,
          category: 'other',
          reason: '😀'.repeat(501),
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (await post(server, hostCookie, { messageRef: 9999, category: 'other' }))
        .statusCode,
    ).toBe(404);
  });

  it('rejects a foreign Origin on the report POST', async () => {
    const ref = await transcript();
    const res = await post(
      app(),
      seatedCookie,
      { messageRef: ref, category: 'other' },
      'https://evil.example',
    );
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('BAD_ORIGIN');
  });

  it('lists open reports for operators only, with reporter identity', async () => {
    const ref = await transcript();
    const server = app();
    await post(server, hostCookie, { messageRef: ref, category: 'other' });
    const denied = await server.inject({
      method: 'GET',
      url: '/api/operator/reports',
      headers: { cookie: hostCookie },
    });
    expect(denied.statusCode).toBe(404);
    const ok = await server.inject({
      method: 'GET',
      url: '/api/operator/reports?status=open&limit=10',
      headers: { cookie: operatorCookie },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().reports).toHaveLength(1);
    expect(ok.json().reports[0]).toMatchObject({
      reporter_account_id: host,
      status: 'open',
    });
    expect(ok.body).not.toContain('_authorId');
    expect(JSON.stringify(ok.json().reports[0].context)).not.toContain(seated);
    const dismissed = await server.inject({
      method: 'GET',
      url: '/api/operator/reports?status=dismissed',
      headers: { cookie: operatorCookie },
    });
    expect(dismissed.json().reports).toHaveLength(0);
  });

  it('lets operators review a report, writes an audit row, and 404s non-operators', async () => {
    const ref = await transcript();
    const server = app();
    await post(server, hostCookie, { messageRef: ref, category: 'other' });
    const id = (await pool().query('SELECT id FROM message_reports')).rows[0]
      .id;
    const url = `/api/operator/reports/${id}`;
    const denied = await server.inject({
      method: 'PATCH',
      url,
      headers: { cookie: seatedCookie, origin: HOST, host: 'lorekeep.test' },
      payload: { status: 'dismissed' },
    });
    expect(denied.statusCode).toBe(404);
    const foreign = await server.inject({
      method: 'PATCH',
      url,
      headers: {
        cookie: operatorCookie,
        origin: 'https://evil.example',
        host: 'lorekeep.test',
      },
      payload: { status: 'dismissed' },
    });
    expect(foreign.statusCode).toBe(403);
    const ok = await server.inject({
      method: 'PATCH',
      url,
      headers: { cookie: operatorCookie, origin: HOST, host: 'lorekeep.test' },
      payload: { status: 'actioned' },
    });
    expect(ok.statusCode).toBe(200);
    const row = (
      await pool().query(
        'SELECT status,reviewed_by,reviewed_at FROM message_reports WHERE id=$1',
        [id],
      )
    ).rows[0];
    expect(row).toMatchObject({ status: 'actioned', reviewed_by: operator });
    expect(row.reviewed_at).not.toBeNull();
    const audit = (
      await pool().query(
        'SELECT actor_id,from_status,to_status FROM message_report_audit WHERE report_id=$1',
        [id],
      )
    ).rows;
    expect(audit).toEqual([
      { actor_id: operator, from_status: 'open', to_status: 'actioned' },
    ]);
    const toReviewed = await server.inject({
      method: 'PATCH',
      url,
      headers: { cookie: operatorCookie, origin: HOST, host: 'lorekeep.test' },
      payload: { status: 'reviewed' },
    });
    expect(toReviewed.statusCode).toBe(200);
    const reopened = await server.inject({
      method: 'PATCH',
      url,
      headers: { cookie: operatorCookie, origin: HOST, host: 'lorekeep.test' },
      payload: { status: 'open' },
    });
    expect(reopened.statusCode).toBe(200);
    expect(
      (
        await pool().query(
          'SELECT reviewed_by,reviewed_at FROM message_reports WHERE id=$1',
          [id],
        )
      ).rows[0],
    ).toEqual({ reviewed_by: null, reviewed_at: null });
    expect(
      (
        await server.inject({
          method: 'PATCH',
          url: `/api/operator/reports/${randomUUID()}`,
          headers: {
            cookie: operatorCookie,
            origin: HOST,
            host: 'lorekeep.test',
          },
          payload: { status: 'dismissed' },
        })
      ).statusCode,
    ).toBe(404);
  });

  it('keeps the report but anonymizes its accounts when those accounts are deleted', async () => {
    const ref = await transcript();
    const reporter = await seatAccount('Reporter');
    await addEvent('SeatJoined', {
      accountId: reporter,
      displayName: 'Reporter',
    });
    await post(app(), await cookieFor(reporter), {
      messageRef: ref,
      category: 'other',
    });
    await pool().query('DELETE FROM accounts WHERE id = ANY($1)', [
      [reporter, seated],
    ]);
    const row = (
      await pool().query(
        'SELECT reporter_account_id,author_account_id,context FROM message_reports',
      )
    ).rows[0];
    expect(row.reporter_account_id).toBeNull();
    expect(row.author_account_id).toBeNull();
    expect(row.context.length).toBe(11);
  });
});
