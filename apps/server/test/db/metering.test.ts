import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from './testDb.js';
import { PostgresUsageSink, readUsage } from '../../src/llm/metering.js';
import { registerUsageRoutes } from '../../src/llm/usageRoutes.js';
import Fastify from 'fastify';
import { createLogger } from '../../src/app.js';
import { randomUUID } from 'node:crypto';

let database: TestDatabase;
const sessionId = randomUUID();
const accountId = randomUUID();
const turnId = randomUUID();
beforeAll(async () => {
  database = await createTestDatabase();
  await database.pool.query(
    'CREATE TABLE sessions (id uuid PRIMARY KEY, owner_account_id uuid NOT NULL)',
  );
  await database.pool.query(`CREATE TABLE endpoint_usage (
    id bigserial PRIMARY KEY, session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    turn_id uuid NOT NULL, purpose text NOT NULL, model_id text NOT NULL,
    input_tokens integer NOT NULL, output_tokens integer NOT NULL, cached_tokens integer NOT NULL, cache_write_tokens integer NOT NULL DEFAULT 0,
    estimated boolean NOT NULL, latency_ms integer NOT NULL, retries integer NOT NULL,
    error_code text, created_at timestamptz NOT NULL DEFAULT now())`);
  await database.pool.query(
    'CREATE TABLE accounts (id uuid PRIMARY KEY, status text NOT NULL)',
  );
  await database.pool.query(
    `CREATE TABLE auth_sessions (token_hash text PRIMARY KEY, account_id uuid NOT NULL, expires_at timestamptz NOT NULL, absolute_expires_at timestamptz NOT NULL, last_active_at timestamptz NOT NULL)`,
  );
  await database.pool.query(
    'INSERT INTO sessions(id,owner_account_id) VALUES($1,$2)',
    [sessionId, accountId],
  );
  await database.pool.query(
    "INSERT INTO accounts(id,status) VALUES($1,'active')",
    [accountId],
  );
  await database.pool.query(
    "INSERT INTO auth_sessions VALUES('fakehash',$1,now()+interval '1 day',now()+interval '2 days',now())",
    [accountId],
  );
});
afterAll(async () => {
  await database?.close();
});

describe('usage metering Postgres and route', () => {
  it('persists each entry and returns per-table and aggregate counts', async () => {
    const sink = new PostgresUsageSink(database.pool);
    await sink.record({
      sessionId,
      turnId,
      purpose: 'narration',
      modelId: 'm',
      inputTokens: 10,
      outputTokens: 2,
      cachedTokens: 1,
      cacheWriteTokens: 2,
      estimated: false,
      latencyMs: 5,
      retries: 1,
      errorCode: null,
    });
    const rows = (await readUsage(database.pool, sessionId)) as Array<
      Record<string, unknown>
    >;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      sessionId,
      calls: 1,
      inputTokens: 10,
      outputTokens: 2,
      cachedTokens: 1,
      cacheWriteTokens: 2,
      retries: 1,
    });
    expect(await readUsage(database.pool)).toHaveLength(1);
  });
  it('requires an authenticated operator for usage reads', async () => {
    const app = Fastify({ loggerInstance: createLogger() });
    registerUsageRoutes(app, database.pool, async (id) => id === accountId);
    const denied = await app.inject({
      url: '/api/operator/usage',
      headers: { cookie: 'sid=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' },
    });
    expect(denied.statusCode).toBe(404);
    const token = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    const { hashToken } = await import('../../src/accounts/signup.js');
    await database.pool.query(
      "INSERT INTO auth_sessions VALUES($1,$2,now()+interval '1 day',now()+interval '2 days',now())",
      [hashToken(token), accountId],
    );
    const allowed = await app.inject({
      url: '/api/operator/usage?sessionId=' + sessionId,
      headers: { cookie: `sid=${token}` },
    });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json().usage).toHaveLength(1);
    const nonOperator = Fastify({ loggerInstance: createLogger() });
    registerUsageRoutes(nonOperator, database.pool, async () => false);
    const deniedOperator = await nonOperator.inject({
      url: '/api/operator/usage',
      headers: { cookie: `sid=${token}` },
    });
    expect(deniedOperator.statusCode).toBe(404);
    await app.close();
    await nonOperator.close();
  });
});
