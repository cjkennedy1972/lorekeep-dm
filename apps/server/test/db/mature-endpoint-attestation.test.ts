import { readdir, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from './testDb.js';
import { registerOperatorRoutes } from '../../src/routes/operator.js';
import { hashToken } from '../../src/accounts/signup.js';
import { createEgressGuard } from '../../src/llm/egress.js';
import { sessionMatureEndpointAllowed } from '../../src/llm/matureEndpoint.js';

const token = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const ack = 'I_CONFIRM_NARRATION_AND_MODERATION_ENDPOINT_POLICIES_ALLOW_MATURE';

async function migrationSql() {
  const dir = new URL('../../migrations/', import.meta.url);
  const names = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  return Promise.all(names.map((n) => readFile(new URL(n, dir), 'utf8')));
}

describe('operator mature endpoint attestation', () => {
  let database: TestDatabase;
  let operatorId: string;
  let sessionId: string;
  let app: Fastify.FastifyInstance;
  const oldSlot = process.env.SOLO_TURN_ENDPOINT_SLOT;

  beforeEach(async () => {
    process.env.SOLO_TURN_ENDPOINT_SLOT = 'fast';
    database = await createTestDatabase({ extraSearchPath: ['public'] });
    for (const sql of await migrationSql()) await database.pool.query(sql);
    operatorId = randomUUID();
    sessionId = randomUUID();
    await database.pool.query(
      `INSERT INTO accounts(id,email,password_hash,display_name,status,is_adult,age_checked_at,terms_version,terms_accepted_at)
       VALUES($1,'op@example.test','h','Operator','active',true,now(),'v1',now())`,
      [operatorId],
    );
    await database.pool.query(
      "INSERT INTO auth_sessions(token_hash,account_id,expires_at,absolute_expires_at,last_active_at) VALUES($1,$2,now()+interval '1 day',now()+interval '2 days',now())",
      [hashToken(token), operatorId],
    );
    await database.pool.query(
      'INSERT INTO sessions(id,owner_account_id,name) VALUES($1,$2,$3)',
      [sessionId, operatorId, 'attestation test'],
    );
    app = Fastify();
    const egress = createEgressGuard({
      resolver: async () => [{ address: '93.184.216.34', family: 4 }],
      transport: async () => {
        throw new Error('unexpected network request');
      },
    });
    registerOperatorRoutes(app, database.pool, async () => true, { egress });
  });

  afterEach(async () => {
    await app.close();
    await database.close();
    if (oldSlot === undefined) delete process.env.SOLO_TURN_ENDPOINT_SLOT;
    else process.env.SOLO_TURN_ENDPOINT_SLOT = oldSlot;
  });

  async function saveEndpointProbe(
    slot: 'fast' | 'moderate',
    technicalSupport: boolean,
  ) {
    await database.pool.query(
      `INSERT INTO operator_endpoints(slot,base_url,model,api_style,probe,updated_at)
       VALUES($1,$2,$3,'openai',$4::jsonb,now())`,
      [
        slot,
        `https://${slot}.llm.example.test/v1`,
        `${slot}-model`,
        JSON.stringify({
          id: slot,
          model: `${slot}-model`,
          toolMode: 'native',
          validCallRate: technicalSupport ? 0.99 : 0.5,
          capabilities: {
            reachability: { supported: technicalSupport },
            streaming: { supported: technicalSupport },
            nativeTools: { supported: technicalSupport },
          },
        }),
      ],
    );
  }

  async function moderationVerified() {
    const { rows } = await database.pool.query<{
      moderation_verified: boolean;
    }>('SELECT moderation_verified FROM sessions WHERE id=$1', [sessionId]);
    return rows[0]?.moderation_verified;
  }

  const patch = (payload: unknown) =>
    app.inject({
      method: 'PATCH',
      url: `/api/operator/sessions/${sessionId}/mature-endpoint`,
      headers: { cookie: `sid=${token}` },
      payload,
    });

  it('requires a technically sufficient current probe and a separate explicit policy attestation', async () => {
    await saveEndpointProbe('fast', true);
    await saveEndpointProbe('moderate', false);
    const noProbe = await patch({
      enabled: true,
      policyAcknowledgement: ack,
    });
    expect(noProbe.statusCode).toBe(409);
    expect(noProbe.json()).toMatchObject({ code: 'ENDPOINT_PROBE_REQUIRED' });
    expect(await moderationVerified()).toBe(false);

    await database.pool.query('DELETE FROM operator_endpoints');
    await saveEndpointProbe('fast', true);
    await saveEndpointProbe('moderate', true);
    const noAck = await patch({ enabled: true });
    expect(noAck.statusCode).toBe(400);
    expect(noAck.json()).toMatchObject({
      code: 'POLICY_ACKNOWLEDGEMENT_REQUIRED',
    });
    expect(await moderationVerified()).toBe(false);

    const enabled = await patch({ enabled: true, policyAcknowledgement: ack });
    expect(enabled.statusCode).toBe(200);
    expect(enabled.json()).toEqual({
      enabled: true,
      narrationEndpointSlot: 'fast',
      moderationEndpointSlot: 'moderate',
    });
    expect(await sessionMatureEndpointAllowed(database.pool, sessionId)).toBe(
      true,
    );
    expect(await moderationVerified()).toBe(true);
  });

  it('fails closed after endpoint config changes and supports operator revocation', async () => {
    await saveEndpointProbe('fast', true);
    await saveEndpointProbe('moderate', true);
    expect(
      (await patch({ enabled: true, policyAcknowledgement: ack })).statusCode,
    ).toBe(200);
    expect(await sessionMatureEndpointAllowed(database.pool, sessionId)).toBe(
      true,
    );

    await database.pool.query(
      "UPDATE operator_endpoints SET updated_at=updated_at + interval '1 second' WHERE slot='fast'",
    );
    expect(await sessionMatureEndpointAllowed(database.pool, sessionId)).toBe(
      false,
    );

    expect(
      (await patch({ enabled: true, policyAcknowledgement: ack })).statusCode,
    ).toBe(200);
    expect(await sessionMatureEndpointAllowed(database.pool, sessionId)).toBe(
      true,
    );

    await database.pool.query(
      "UPDATE operator_endpoints SET updated_at=updated_at + interval '1 second' WHERE slot='moderate'",
    );
    expect(await sessionMatureEndpointAllowed(database.pool, sessionId)).toBe(
      false,
    );

    const revoked = await patch({ enabled: false });
    expect(revoked.statusCode).toBe(200);
    expect(await sessionMatureEndpointAllowed(database.pool, sessionId)).toBe(
      false,
    );
    expect(await moderationVerified()).toBe(false);
  });

  it('disables mature flags before migration rollback drops endpoint bindings', async () => {
    await saveEndpointProbe('fast', true);
    await saveEndpointProbe('moderate', true);
    expect(
      (
        await patch({
          enabled: true,
          policyAcknowledgement: ack,
        })
      ).statusCode,
    ).toBe(200);

    const migration = await import(
      '../../migrations/0034_mature_endpoint_attestation.js'
    );
    const statements: string[] = [];
    migration.down({ sql: (statement: string) => statements.push(statement) });
    for (const statement of statements) await database.pool.query(statement);

    const session = await database.pool.query<{
      endpoint_allows_mature: boolean;
      moderation_verified: boolean;
    }>(
      'SELECT endpoint_allows_mature, moderation_verified FROM sessions WHERE id=$1',
      [sessionId],
    );
    expect(session.rows[0]).toMatchObject({
      endpoint_allows_mature: false,
      moderation_verified: false,
    });
    const columns = await database.pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema=current_schema() AND table_name='sessions'
          AND column_name IN ('endpoint_mature_fingerprint','moderation_mature_fingerprint')`,
    );
    expect(columns.rows).toEqual([]);
  });
});
