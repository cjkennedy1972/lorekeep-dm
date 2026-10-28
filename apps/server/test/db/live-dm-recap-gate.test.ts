import { allowInputGate } from '../support/allowInputGate.js';
import { randomBytes, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadCatalog } from '@game/rules-engine/catalog-node';
import { createApp } from '../../src/app.js';
import { COOKIE_NAME, createSession } from '../../src/accounts/sessions.js';
import { ConnectionRegistry } from '../../src/gateway/connections.js';
import { RegistryMemory } from '../../src/dm/memory.js';
import {
  buildPlayerVisibleRecap,
  SAFE_RECAP_FALLBACK,
} from '../../src/dm/recap.js';
import { createEndpointEgress, saveEndpoint } from '../../src/llm/config.js';
import { buildLateJoinRecap } from '../../src/dm/lateJoinRecap.js';
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
  SOLO_TURN_ENDPOINT_SLOT: process.env.SOLO_TURN_ENDPOINT_SLOT,
};
const catalog = loadCatalog();
let db: Pool;
let endpoint: FakeOpenAIServer;
let moderationEndpoint: FakeOpenAIServer;
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

async function createResumableTable(
  ownerId: string,
  tier: string | undefined = 'standard',
) {
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
  await db.query(
    `INSERT INTO events(session_id,seq,turn_id,type,payload)
     SELECT $1,COALESCE(MAX(seq),0)+1,$2,'NarrationCompleted',$3::jsonb
       FROM events WHERE session_id=$1`,
    [
      id,
      randomUUID(),
      JSON.stringify({
        narration: 'The adventurer followed the lantern light into Greyfen.',
        ...(tier ? { tier } : {}),
      }),
    ],
  );
  return id;
}

beforeAll(async () => {
  db = new Pool({ connectionString: databaseUrl });
  endpoint = await startFakeOpenAIServer({ chunks: textStream });
  moderationEndpoint = await startFakeOpenAIServer({
    chunks: [
      'data: {"choices":[{"index":0,"delta":{"content":"{\\"verdict\\":\\"block\\",\\"category\\":\\"violence\\"}"}}]}\n\n',
      'data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5}}\n\n',
      'data: [DONE]\n\n',
    ],
  });
  process.env.NODE_ENV = 'production';
  delete process.env.LLM_FIXTURE_MODE;
  process.env.LLM_ALLOW_LOCAL_HOSTS = [
    new URL(endpoint.baseUrl).host,
    new URL(moderationEndpoint.baseUrl).host,
  ].join(',');
  process.env.OPERATOR_ENDPOINT_MASTER_KEY = `primary:${randomBytes(32).toString('base64')}`;
  process.env.SOLO_TURN_ENDPOINT_SLOT = 'fast';
  operatorEmail = `operator-${randomUUID()}@example.test`;
  process.env.OPERATOR_EMAILS = operatorEmail;
  const endpointOwner = await createAccount();
  await db.query(
    `INSERT INTO catalog_snapshots(catalog_version,entries) VALUES($1,$2::jsonb) ON CONFLICT (catalog_version) DO NOTHING`,
    [catalog.catalogVersion, JSON.stringify(catalog.entries)],
  );
  await saveEndpoint(
    db,
    'moderate',
    {
      baseUrl: moderationEndpoint.baseUrl,
      model: 'fixture-model',
      apiStyle: 'openai',
      apiKey: 'fixture-secret',
      unsupportedToolSchemaKeywords: [],
    },
    createEndpointEgress(),
    endpointOwner.id,
  );
  await saveEndpoint(
    db,
    'fast',
    {
      baseUrl: endpoint.baseUrl,
      model: 'fixture-model',
      apiStyle: 'openai',
      apiKey: 'fixture-secret',
      unsupportedToolSchemaKeywords: [],
    },
    createEndpointEgress(),
    endpointOwner.id,
  );
  rooms = new RoomRegistry(
    new Persistence(db),
    new SessionLease(db),
    'recap-gate-db',
    600_000,
    60_000,
  );
  app = createApp(db, {
    inputGate: allowInputGate,
    rooms,
    connections: new ConnectionRegistry(db),
    liveDmAllowlistOnly: true,
    cookieSecret: 'live-dm-recap-gate-test-secret',
  });
  base = await app.listen({ host: '127.0.0.1', port: 0 });
});

afterAll(async () => {
  await rooms?.drain();
  await app?.close();
  for (const id of sessionIds) await db.query('SELECT purge_session($1)', [id]);
  for (const id of accountIds)
    await db.query('DELETE FROM accounts WHERE id=$1', [id]);
  await db.query(
    "DELETE FROM operator_endpoints WHERE slot IN ('moderate','fast')",
  );
  await endpoint?.close();
  await moderationEndpoint?.close();
  await db.end();
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('resume recap and the live DM allowlist', () => {
  it('gates deterministic recap for a non-allowlisted owner before returning it', async () => {
    const player = await createAccount();
    const table = await createResumableTable(player.id);
    const moderationCalls = moderationEndpoint.requests.length;
    const generationCalls = endpoint.requests.length;
    const response = await fetch(`${base}/api/tables/${table}`, {
      headers: { cookie: `${COOKIE_NAME}=${player.token}` },
    });
    expect(response.status).toBe(200);
    expect((await response.json()).game.recap).toBe(SAFE_RECAP_FALLBACK);
    // The authored block verdict is exercised; recap generation does not call the narrator.
    expect(moderationEndpoint.requests.length).toBe(moderationCalls + 1);
    expect(endpoint.requests.length).toBe(generationCalls);
  });

  it('excludes mature and unknown-tier narration from resume and list recaps', async () => {
    const player = await createAccount();
    const table = await createResumableTable(player.id);
    const addNarration = async (narration: string, tier?: string) => {
      await db.query(
        `INSERT INTO events(session_id,seq,turn_id,type,payload)
         SELECT $1,COALESCE(MAX(seq),0)+1,$2,'NarrationCompleted',$3::jsonb
           FROM events WHERE session_id=$1`,
        [
          table,
          randomUUID(),
          JSON.stringify({ narration, ...(tier ? { tier } : {}) }),
        ],
      );
    };
    await addNarration('MATURE_MARKER forbidden scene.', 'mature');
    await addNarration('UNKNOWN_MARKER unclassified scene.');
    await addNarration('STANDARD_MARKER the party found a bridge.', 'standard');

    const built = await buildPlayerVisibleRecap({ db, sessionId: table });
    expect(built.recap).toContain('STANDARD_MARKER');
    expect(built.recap).not.toContain('MATURE_MARKER');
    expect(built.recap).not.toContain('UNKNOWN_MARKER');

    const resume = await fetch(`${base}/api/tables/${table}`, {
      headers: { cookie: `${COOKIE_NAME}=${player.token}` },
    });
    expect(resume.status).toBe(200);
    const resumeBody = await resume.text();
    expect(resumeBody).not.toContain('MATURE_MARKER');
    expect(resumeBody).not.toContain('UNKNOWN_MARKER');

    const list = await fetch(`${base}/api/tables`, {
      headers: { cookie: `${COOKIE_NAME}=${player.token}` },
    });
    expect(list.status).toBe(200);
    const listBody = await list.text();
    expect(listBody).not.toContain('MATURE_MARKER');
    expect(listBody).not.toContain('UNKNOWN_MARKER');
  });

  it('excludes reverted-turn narration from resume and list recaps', async () => {
    const player = await createAccount();
    const table = await createResumableTable(player.id);
    const keptTurn = randomUUID();
    const revertedTurn = randomUUID();
    const rewindTurn = randomUUID();
    const addTurnNarration = async (turnId: string, narration: string) => {
      await db.query(
        `INSERT INTO events(session_id,seq,turn_id,type,payload)
         SELECT $1,COALESCE(MAX(seq),0)+1,$2,'NarrationCompleted',$3::jsonb
           FROM events WHERE session_id=$1`,
        [table, turnId, JSON.stringify({ narration, tier: 'standard' })],
      );
    };
    await addTurnNarration(
      keptTurn,
      'KEPT_MARKER the party crossed the river.',
    );
    await addTurnNarration(
      revertedTurn,
      'REVERTED_MARKER the party entered the vault.',
    );
    await db.query(
      `INSERT INTO events(session_id,seq,turn_id,type,payload)
       SELECT $1,COALESCE(MAX(seq),0)+1,$2,'TurnReverted',$3::jsonb
         FROM events WHERE session_id=$1`,
      [table, rewindTurn, JSON.stringify({ revertedTurnId: revertedTurn })],
    );

    const built = await buildPlayerVisibleRecap({ db, sessionId: table });
    expect(built.recap).toContain('KEPT_MARKER');
    expect(built.recap).not.toContain('REVERTED_MARKER');

    const lateJoin = await buildLateJoinRecap({
      db,
      sessionId: table,
      moderator: { moderate: async () => ({ verdict: 'allow' }) } as never,
      tier: 'standard',
      tableLines: [],
    });
    expect(lateJoin.recap).toContain('KEPT_MARKER');
    expect(lateJoin.recap).not.toContain('REVERTED_MARKER');

    const headers = { cookie: `${COOKIE_NAME}=${player.token}` };
    const resume = await fetch(`${base}/api/tables/${table}`, { headers });
    expect(resume.status).toBe(200);
    const resumeBody = await resume.text();
    expect(resumeBody).not.toContain('REVERTED_MARKER');

    const list = await fetch(`${base}/api/tables`, { headers });
    expect(list.status).toBe(200);
    const listBody = await list.text();
    expect(listBody).not.toContain('REVERTED_MARKER');
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

  it('screens historical snapshot recaps before returning the games list', async () => {
    const player = await createAccount();
    const table = await createResumableTable(player.id);
    const room = await rooms.get(table);
    await room.persistRecap({
      recap: 'Unsafe historical recap that must not reach the client.',
      memoryHash: 'stale',
    });

    const response = await fetch(`${base}/api/tables`, {
      headers: { cookie: `${COOKIE_NAME}=${player.token}` },
    });
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).not.toContain('Unsafe historical recap');
    expect(JSON.parse(body).games[0].recap).toBe('');
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
