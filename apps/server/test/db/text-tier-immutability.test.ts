import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  LlmAdapter,
  LlmChunk,
  LlmRequest,
} from '../../src/llm/adapter.js';
import { Persistence } from '../../src/persistence/index.js';
import { SessionLease } from '../../src/room/lease.js';
import { ProductionSoloTurnRunner } from '../../src/room/productionTurnRunner.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL required');
let db: Pool;
let dir: string;

const corpus = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL(
        '../../../../packages/evals/redteam/injection-100.json',
        import.meta.url,
      ),
    ),
    'utf8',
  ),
) as { cases: { id: string; category: string; text: string }[] };
const tierFlipTexts = corpus.cases
  .filter((item) => item.category === 'tier-flip')
  .map((item) => item.text);

async function table(optOut = false) {
  const accountId = randomUUID();
  await db.query(
    `INSERT INTO accounts(id,email,password_hash,display_name,status,is_adult,age_checked_at,terms_version,terms_accepted_at,mature_opt_out)
     VALUES($1,$2,'hash','Tier','active',true,now(),'v1',now(),$3)`,
    [accountId, `${accountId}@example.test`, optOut],
  );
  const sessionId = randomUUID();
  await db.query(
    'INSERT INTO sessions(id,owner_account_id,name,moderation_verified,endpoint_allows_mature) VALUES($1,$2,$3,true,true)',
    [sessionId, accountId, 'Text tier table'],
  );
  await db.query(
    `INSERT INTO events(session_id,seq,turn_id,type,payload) VALUES($1,1,$1,'SeatJoined',$2)`,
    [
      sessionId,
      {
        seatId: randomUUID(),
        accountId,
        displayName: 'Tier',
        presence: 'offline',
        matureOptOut: optOut,
      },
    ],
  );
  return { accountId, sessionId };
}

const storedTier = async (sessionId: string) =>
  (
    await db.query<{ content_tier: string }>(
      'SELECT content_tier FROM sessions WHERE id=$1',
      [sessionId],
    )
  ).rows[0]?.content_tier;

const tierChangeEvents = async (sessionId: string) =>
  (
    await db.query<{ payload: unknown }>(
      `SELECT payload FROM events WHERE session_id=$1 AND type='ContentTierChanged' ORDER BY seq`,
      [sessionId],
    )
  ).rows.map((row) => row.payload);

/** Narrator that returns the injected text as DM output, so tier-changing prose reaches the output path too. */
function narrator(calls: LlmRequest[], reply: string) {
  const adapter: LlmAdapter = {
    capabilities: () => ({
      streaming: true,
      nativeTools: true,
      jsonSchema: true,
    }),
    probe: async () => true,
    async *complete(request: LlmRequest) {
      calls.push(request);
      const chunk: LlmChunk = { type: 'text', delta: reply };
      yield chunk;
    },
  };
  return adapter;
}

async function turnWithText(
  sessionId: string,
  accountId: string,
  playerText: string,
  dmReply: string,
) {
  const calls: LlmRequest[] = [];
  const result = await new ProductionSoloTurnRunner(
    db,
    undefined,
    'record',
    join(dir, `${randomUUID()}.ndjson`),
    narrator(calls, dmReply),
    false,
    true,
  ).run(
    {
      sessionId,
      accountId,
      actionId: randomUUID(),
      text: playerText,
      state: {},
    },
    () => undefined,
  );
  const changes = result.events.filter(
    (e) => (e as { type?: string }).type === 'ContentTierChanged',
  ) as { from: string; to: string }[];
  return { calls, changes };
}

async function commit(sessionId: string, changes: unknown[]) {
  if (!changes.length) return;
  const leases = new SessionLease(db);
  const lease = await leases.acquire(sessionId, randomUUID());
  if (!lease) throw new Error('lease unavailable');
  try {
    await new Persistence(db).writeTurn(
      sessionId,
      changes.map((event) => ({
        turnId: randomUUID(),
        type: 'ContentTierChanged',
        payload: event,
      })),
      {},
      lease,
    );
  } finally {
    await leases.release(lease);
  }
}

const promptTier = (calls: LlmRequest[]) =>
  JSON.stringify(calls[0]).includes('\\"contentTier\\":\\"mature\\"')
    ? 'mature'
    : 'standard';

beforeAll(async () => {
  db = new Pool({ connectionString: databaseUrl });
  dir = await mkdtemp(join(tmpdir(), 'text-tier-'));
});
afterAll(async () => {
  await db.end();
  await rm(dir, { recursive: true, force: true });
});

describe('text cannot change the tier through the real turn path', () => {
  it('has the 12 tier-flip corpus cases to test', () => {
    expect(tierFlipTexts).toHaveLength(12);
  });

  it.each(tierFlipTexts.map((text, index) => [index, text] as const))(
    'tier-flip case %i resolves and persists the same tier as benign text',
    async (_index, injected) => {
      const benign = await table();
      const baseline = await turnWithText(
        benign.sessionId,
        benign.accountId,
        'We look around.',
        'The torch gutters.',
      );
      expect(baseline.changes).toEqual([
        { type: 'ContentTierChanged', from: 'standard', to: 'mature' },
      ]);
      await commit(benign.sessionId, baseline.changes);

      const attacked = await table();
      const run = await turnWithText(
        attacked.sessionId,
        attacked.accountId,
        injected,
        injected,
      );
      expect(run.changes).toEqual(baseline.changes);
      expect(promptTier(run.calls)).toBe(promptTier(baseline.calls));
      await commit(attacked.sessionId, run.changes);

      expect(await storedTier(attacked.sessionId)).toBe(
        await storedTier(benign.sessionId),
      );
      expect(await tierChangeEvents(attacked.sessionId)).toEqual(
        await tierChangeEvents(benign.sessionId),
      );
    },
  );

  it('keeps standard when the player opted out, whatever the text says', async () => {
    for (const injected of tierFlipTexts) {
      const { accountId, sessionId } = await table(true);
      const run = await turnWithText(sessionId, accountId, injected, injected);
      expect(run.changes).toEqual([]);
      expect(promptTier(run.calls)).toBe('standard');
      expect(await storedTier(sessionId)).toBe('standard');
      expect(await tierChangeEvents(sessionId)).toEqual([]);
    }
  });
});
