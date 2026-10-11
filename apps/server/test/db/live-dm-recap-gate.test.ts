import { allowInputGate } from '../support/allowInputGate.js';
import { randomBytes, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadCatalog } from '@game/rules-engine/catalog-node';
import { createApp } from '../../src/app.js';
import { COOKIE_NAME, createSession } from '../../src/accounts/sessions.js';
import { ConnectionRegistry } from '../../src/gateway/connections.js';
import { RegistryMemory } from '../../src/dm/memory.js';
import { createEndpointEgress, saveEndpoint } from '../../src/llm/config.js';
import { Persistence } from '../../src/persistence/index.js';
import { RoomRegistry } from '../../src/room/registry.js';
import { SessionLease } from '../../src/room/lease.js';
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
  LLM_ALLOW_LOCAL_HOSTS: process.env.LLM_ALLOW_LOCAL_HOSTS,
  OPERATOR_ENDPOINT_MASTER_KEY: process.env.OPERATOR_ENDPOINT_MASTER_KEY,
  OPERATOR_EMAILS: process.env.OPERATOR_EMAILS,
};
const catalog = loadCatalog();
let db: Pool;
let endpoint: FakeOpenAIServer;
let rooms: RoomRegistry;
let app: ReturnType<typeof createApp>;
let base = '';
const accountIds: string[] = [];
const sessionIds: string[] = [];
let operatorEmail = '';

async function createAccount(email = `${randomUUID()}@example.test`) {
  const id = randomUUID();
  await db.query(
    `INSERT INTO accounts(id,email,password_hash,display_name,status,is_adult,age_checked_at,terms_version,terms_accepted_at) VALUES($1,$2,'hash','Recap','active',true,now(),'v1',now())`,
    [id, email],
  );
  accountIds.push(id);
  return { id, token: await createSession(db, id, 'recap-gate-test') };
}

async function createResumableTable(ownerId: string) {
  const id = randomUUID();
  await db.query(
    `INSERT INTO sessions(id,owner_account_id,name,mode,catalog_version) VALUES($1,$2,'Recap table','solo',$3)`,
    [id, ownerId, catalog.catalogVersion],
  );
  sessionIds.push(id);
  await new RegistryMemory(db).closeScene(
    id,
    'scene:opening',
    'The adventurer followed the lantern light into Greyfen.',
  );
  return id;
}

beforeAll(async () => {
  db = new Pool({ connectionString: databaseUrl });
  endpoint = await startFakeOpenAIServer({ chunks: textStream });
  process.env.NODE_ENV = 'production';
  delete process.env.LLM_FIXTURE_MODE;
  process.env.LLM_ALLOW_LOCAL_HOSTS = '127.0.0.1';
  process.env.OPERATOR_ENDPOINT_MASTER_KEY = `primary:${randomBytes(32).toString('base64')}`;
  operatorEmail = `operator-${randomUUID()}@example.test`;
  process.env.OPERATOR_EMAILS = operatorEmail;
  await db.query(
    `INSERT INTO catalog_snapshots(catalog_version,entries) VALUES($1,$2::jsonb) ON CONFLICT (catalog_version) DO NOTHING`,
    [catalog.catalogVersion, JSON.stringify(catalog.entries)],
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
  );
  rooms = new RoomRegistry(
    new Persistence(db),
    new SessionLease(db),
    'recap-gate-db',
    600_000,
    60_000,
  );
  app = createApp(
    db,
    {
      inputGate: allowInputGate,
      rooms,
      connections: new ConnectionRegistry(db),
      liveDmAllowlistOnly: true,
      cookieSecret: 'live-dm-recap-gate-test-secret',
    },
    { inputGate: allowInputGate },
  );
  base = await app.listen({ host: '127.0.0.1', port: 0 });
});

afterAll(async () => {
  await rooms?.drain();
  await app?.close();
  for (const id of sessionIds) await db.query('SELECT purge_session($1)', [id]);
  for (const id of accountIds)
    await db.query('DELETE FROM accounts WHERE id=$1', [id]);
  await db.query("DELETE FROM operator_endpoints WHERE slot='moderate'");
  await endpoint?.close();
  await db.end();
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('resume recap and the live DM allowlist', () => {
  it('builds a deterministic recap without calling the endpoint for a non-allowlisted owner', async () => {
    const player = await createAccount();
    const table = await createResumableTable(player.id);
    const calls = endpoint.requests.length;
    const response = await fetch(`${base}/api/tables/${table}`, {
      headers: { cookie: `${COOKIE_NAME}=${player.token}` },
    });
    expect(response.status).toBe(200);
    expect((await response.json()).game.recap).toContain(
      'followed the lantern light',
    );
    expect(endpoint.requests.length).toBe(calls);
  });

  it('still calls the endpoint for an allowlisted operator owner', async () => {
    const operator = await createAccount(operatorEmail);
    const table = await createResumableTable(operator.id);
    const calls = endpoint.requests.length;
    const response = await fetch(`${base}/api/tables/${table}`, {
      headers: { cookie: `${COOKIE_NAME}=${operator.token}` },
    });
    expect(response.status).toBe(200);
    expect(endpoint.requests.length).toBeGreaterThan(calls);
  });
});

describe('resume snapshot projection', () => {
  it('omits last-turn narration from the GET snapshot for an opted-out owner', async () => {
    const owner = await createAccount();
    await db.query('UPDATE accounts SET mature_opt_out=true WHERE id=$1', [
      owner.id,
    ]);
    const table = await createResumableTable(owner.id);
    const room = await rooms.get(table);
    await room.persistGameState({
      sceneId: 'scene:opening',
      lastNarration: 'The torch gutters.',
      lastPlayerText: 'look around',
    });
    const response = await fetch(`${base}/api/tables/${table}`, {
      headers: { cookie: `${COOKIE_NAME}=${owner.token}` },
    });
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).not.toContain('The torch gutters.');
    expect(body).not.toContain('look around');
  });
});
