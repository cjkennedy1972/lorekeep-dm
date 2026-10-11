import { readdir, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { Pool } from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from './testDb.js';
import { registerOperatorRoutes } from '../../src/routes/operator.js';
import { hashToken } from '../../src/accounts/signup.js';
import { createEgressGuard } from '../../src/llm/egress.js';
import { purgeLogs } from '../../src/retention/jobs/logs.js';
import type { JobContext } from '../../src/retention/types.js';

const operatorToken = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const playerToken = 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const apiKey = ['operator-', 'credential', '-sentinel'].join('');

async function migrationSql() {
  const dir = new URL('../../migrations/', import.meta.url);
  const names = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  return Promise.all(names.map((n) => readFile(new URL(n, dir), 'utf8')));
}

describe('operator endpoint audit: denied attempts', () => {
  let database: TestDatabase;
  let operatorId: string;
  let playerId: string;

  beforeEach(async () => {
    database = await createTestDatabase({ extraSearchPath: ['public'] });
    for (const sql of await migrationSql()) await database.pool.query(sql);
    operatorId = randomUUID();
    playerId = randomUUID();
    for (const [id, email] of [
      [operatorId, 'op@example.test'],
      [playerId, 'player@example.test'],
    ] as const)
      await database.pool.query(
        `INSERT INTO accounts(id,email,password_hash,display_name,status,is_adult,age_checked_at,terms_version,terms_accepted_at)
         VALUES($1,$2,'h','Name','active',true,now(),'v1',now())`,
        [id, email],
      );
    for (const [account, token] of [
      [operatorId, operatorToken],
      [playerId, playerToken],
    ] as const)
      await database.pool.query(
        "INSERT INTO auth_sessions(token_hash,account_id,expires_at,absolute_expires_at,last_active_at) VALUES($1,$2,now()+interval '1 day',now()+interval '2 days',now())",
        [hashToken(token), account],
      );
  });

  afterEach(async () => {
    await database.close();
  });

  function buildApp() {
    const app = Fastify();
    const egress = createEgressGuard({
      resolver: async () => [{ address: '93.184.216.34', family: 4 }],
      transport: async () => {
        throw new Error('no probe in audit tests');
      },
    });
    registerOperatorRoutes(
      app,
      database.pool,
      async (id) => id === operatorId,
      {
        egress,
      },
    );
    return app;
  }

  const audit = async () =>
    (
      await database.pool.query<Record<string, unknown>>(
        'SELECT slot,action,actor_id,reason,details,extract(epoch FROM expires_at - created_at) AS lifetime_s FROM operator_endpoint_audit ORDER BY id',
      )
    ).rows;

  const validSave = {
    baseUrl: 'https://api.example.test/v1',
    model: 'm',
    apiStyle: 'openai',
    apiKey,
  };

  it('records non-operator and anonymous denials with actor, reason and 30-day expiry', async () => {
    const app = buildApp();
    const player = await app.inject({
      method: 'PUT',
      url: '/api/operator/endpoints/fast',
      headers: { cookie: `sid=${playerToken}` },
      payload: validSave,
    });
    const anonymous = await app.inject({
      url: '/api/operator/endpoints',
    });
    expect(player.statusCode).toBe(404);
    expect(anonymous.statusCode).toBe(404);

    const rows = await audit();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      slot: 'fast',
      action: 'denied',
      actor_id: playerId,
      reason: 'NOT_OPERATOR',
      details: { method: 'PUT', route: '/api/operator/endpoints/:slot' },
    });
    expect(rows[1]).toMatchObject({
      slot: null,
      action: 'denied',
      actor_id: null,
      reason: 'UNAUTHENTICATED',
      details: { method: 'GET', route: '/api/operator/endpoints' },
    });
    for (const row of rows)
      expect(Number(row.lifetime_s)).toBe(30 * 24 * 60 * 60);
  });

  it('records rejected saves with a reason code and no URL credentials or key material', async () => {
    const app = buildApp();
    const rejected = await app.inject({
      method: 'PUT',
      url: '/api/operator/endpoints/fast',
      headers: { cookie: `sid=${operatorToken}` },
      payload: {
        ...validSave,
        baseUrl: 'https://user:hunter2@api.example.test/v1',
      },
    });
    expect(rejected.statusCode).toBe(400);

    const rows = await audit();
    expect(rows).toEqual([
      expect.objectContaining({
        slot: 'fast',
        action: 'denied',
        actor_id: operatorId,
        reason: 'INVALID_ENDPOINT_URL',
      }),
    ]);
    const serialized = JSON.stringify(rows);
    expect(serialized).not.toContain('hunter2');
    expect(serialized).not.toContain('api.example.test');
    expect(serialized).not.toContain(apiKey);
  });

  it('records KEY_REQUIRED rejections on endpoint change without a new key', async () => {
    const app = buildApp();
    const headers = { cookie: `sid=${operatorToken}` };
    await app.inject({
      method: 'PUT',
      url: '/api/operator/endpoints/fast',
      headers,
      payload: validSave,
    });
    const changed = await app.inject({
      method: 'PUT',
      url: '/api/operator/endpoints/fast',
      headers,
      payload: {
        baseUrl: 'https://other.example.test/v1',
        model: 'm',
        apiStyle: 'openai',
      },
    });
    expect(changed.statusCode).toBe(400);
    expect((await audit()).at(-1)).toMatchObject({
      action: 'denied',
      reason: 'KEY_REQUIRED',
      slot: 'fast',
    });
  });

  it('gives successful saves host-only details: key-change flag and fingerprint, no key or path', async () => {
    const app = buildApp();
    const saved = await app.inject({
      method: 'PUT',
      url: '/api/operator/endpoints/fast',
      headers: { cookie: `sid=${operatorToken}` },
      payload: validSave,
    });
    expect(saved.statusCode).toBe(200);
    const [row] = await audit();
    expect(row).toMatchObject({
      slot: 'fast',
      action: 'created',
      reason: null,
      details: {
        host: 'api.example.test',
        keyChanged: true,
        fingerprint: expect.stringMatching(/^v2:[0-9a-f]{12}$/),
      },
    });
    expect(JSON.stringify(row)).not.toContain('/v1');
    expect(JSON.stringify(row)).not.toContain(apiKey);
  });

  it('caps denied rows per caller per day', async () => {
    const app = buildApp();
    for (let i = 0; i < 105; i += 1)
      await app.inject({ url: '/api/operator/endpoints' });
    const rows = await audit();
    expect(rows).toHaveLength(100);
    expect(rows.every((row) => row.actor_id === null)).toBe(true);
  });

  it('is purged by the logs job once expires_at passes', async () => {
    // purge_expired_events reads public.events, so the job runs against public like retention.test.ts.
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    try {
      const [expired, fresh] = (
        await pool.query<{ id: string }>(
          `INSERT INTO operator_endpoint_audit(action,reason,actor_id,expires_at) VALUES
           ('denied','NOT_OPERATOR',$1,now()-interval '1 second'),
           ('denied','NOT_OPERATOR',$1,now()+interval '1 day')
           RETURNING id`,
          [randomUUID()],
        )
      ).rows;
      await purgeLogs({
        db: pool,
        store: {} as JobContext['store'],
        now: new Date(),
        log: () => undefined,
      });
      const left = (
        await pool.query<{ id: string }>(
          'SELECT id FROM operator_endpoint_audit WHERE id = ANY($1::bigint[])',
          [[expired!.id, fresh!.id]],
        )
      ).rows.map((row) => row.id);
      expect(left).toEqual([fresh!.id]);
      await pool.query('DELETE FROM operator_endpoint_audit WHERE id=$1', [
        fresh!.id,
      ]);
    } finally {
      await pool.end();
    }
  });
});
