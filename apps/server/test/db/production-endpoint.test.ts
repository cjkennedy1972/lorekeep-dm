import { randomBytes, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createEndpointEgress, saveEndpoint } from '../../src/llm/config.js';
import { ProductionSoloTurnRunner } from '../../src/room/productionTurnRunner.js';
import {
  startFakeOpenAIServer,
  textStream,
  type FakeOpenAIServer,
} from '../llm/fakeOpenAIServer.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL required');

const saved = {
  NODE_ENV: process.env.NODE_ENV,
  LLM_FIXTURE_MODE: process.env.LLM_FIXTURE_MODE,
  LLM_FIXTURE_PATH: process.env.LLM_FIXTURE_PATH,
  LLM_ALLOW_LOCAL_HOSTS: process.env.LLM_ALLOW_LOCAL_HOSTS,
  OPERATOR_ENDPOINT_MASTER_KEY: process.env.OPERATOR_ENDPOINT_MASTER_KEY,
  OPERATOR_EMAILS: process.env.OPERATOR_EMAILS,
};
let db: Pool;
let endpoint: FakeOpenAIServer;
let ownerId: string;
let sessionId: string;

beforeAll(async () => {
  db = new Pool({ connectionString: databaseUrl });
  endpoint = await startFakeOpenAIServer({ chunks: textStream });
  process.env.LLM_ALLOW_LOCAL_HOSTS = '127.0.0.1';
  process.env.OPERATOR_ENDPOINT_MASTER_KEY = `primary:${randomBytes(32).toString('base64')}`;
  ownerId = randomUUID();
  sessionId = randomUUID();
  await db.query(
    `INSERT INTO accounts(id,email,password_hash,display_name,status,is_adult,age_checked_at,terms_version,terms_accepted_at) VALUES($1,$2,'hash','Prod','active',true,now(),'v1',now())`,
    [ownerId, `${ownerId}@example.test`],
  );
  await db.query(
    'INSERT INTO sessions(id,owner_account_id,name) VALUES($1,$2,$3)',
    [sessionId, ownerId, 'Production solo table'],
  );
  await saveEndpoint(
    db,
    'moderate',
    {
      baseUrl: endpoint.baseUrl,
      model: 'fixture-model',
      apiStyle: 'openai',
      apiKey: 'fixture-secret',
      unsupportedToolSchemaKeywords: [],
    },
    createEndpointEgress(),
    ownerId,
  );
});

afterAll(async () => {
  await endpoint?.close();
  await db.query("DELETE FROM operator_endpoints WHERE slot='moderate'");
  await db.query('SELECT purge_session($1)', [sessionId]);
  await db.query('DELETE FROM accounts WHERE id=$1', [ownerId]);
  await db.end();
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('ProductionSoloTurnRunner under default production env', () => {
  it('sends the solo turn to the configured endpoint', async () => {
    process.env.NODE_ENV = 'production';
    process.env.OPERATOR_EMAILS = `${ownerId}@example.test`;
    delete process.env.LLM_FIXTURE_MODE;
    delete process.env.LLM_FIXTURE_PATH;
    const runner = new ProductionSoloTurnRunner(db);
    const result = await runner.run(
      {
        sessionId,
        accountId: ownerId,
        actionId: randomUUID(),
        text: 'Look at the old door.',
        state: {},
      },
      () => undefined,
    );
    expect(endpoint.requests).toHaveLength(1);
    expect(result.narration).toContain('hello world');
  });
});
