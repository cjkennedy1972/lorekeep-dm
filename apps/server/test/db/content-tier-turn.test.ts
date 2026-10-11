import { allowInputGate } from '../support/allowInputGate.js';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  LlmAdapter,
  LlmChunk,
  LlmRequest,
} from '../../src/llm/adapter.js';
import { createApp } from '../../src/app.js';
import { createSession } from '../../src/accounts/sessions.js';
import { Persistence } from '../../src/persistence/index.js';
import { SessionLease } from '../../src/room/lease.js';
import { ProductionSoloTurnRunner } from '../../src/room/productionTurnRunner.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL required');
let db: Pool;
let dir: string;

function narrator(calls: LlmRequest[], beforeNarration?: () => Promise<void>) {
  const adapter: LlmAdapter = {
    capabilities: () => ({
      streaming: true,
      nativeTools: true,
      jsonSchema: true,
    }),
    probe: async () => true,
    async *complete(request: LlmRequest) {
      calls.push(request);
      await beforeNarration?.();
      const chunk: LlmChunk = { type: 'text', delta: 'The torch gutters.' };
      yield chunk;
    },
  };
  return adapter;
}

/** Runs `onFirstTableRead` once, before the turn reads its session row (round open to narration). */
function hookedDb(onFirstTableRead: () => Promise<void>) {
  let armed = true;
  return {
    query(text: string, values?: unknown[]) {
      const before =
        armed && text.includes('LEFT JOIN accounts')
          ? ((armed = false), onFirstTableRead())
          : Promise.resolve();
      return before.then(() => db.query(text, values as never));
    },
  } as unknown as Pick<Pool, 'query'>;
}

async function table(options: { seated?: boolean; verified?: boolean } = {}) {
  const accountId = randomUUID();
  await db.query(
    `INSERT INTO accounts(id,email,password_hash,display_name,status,is_adult,age_checked_at,terms_version,terms_accepted_at,mature_opt_out)
     VALUES($1,$2,'hash','Tier','active',true,now(),'v1',now(),false)`,
    [accountId, `${accountId}@example.test`],
  );
  const sessionId = randomUUID();
  await db.query(
    'INSERT INTO sessions(id,owner_account_id,name,moderation_verified) VALUES($1,$2,$3,$4)',
    [sessionId, accountId, 'Tier table', options.verified ?? true],
  );
  if (options.seated ?? true)
    await db.query(
      `INSERT INTO events(session_id,seq,turn_id,type,payload) VALUES($1,1,$1,'SeatJoined',$2)`,
      [
        sessionId,
        {
          seatId: randomUUID(),
          accountId,
          displayName: 'Tier',
          presence: 'offline',
          matureOptOut: false,
        },
      ],
    );
  return { accountId, sessionId };
}

const setOptOut = (accountId: string, optOut: boolean) =>
  db.query('UPDATE accounts SET mature_opt_out=$2 WHERE id=$1', [
    accountId,
    optOut,
  ]);

function runner(
  queryDb: Pick<Pool, 'query'>,
  calls: LlmRequest[],
  beforeNarration?: () => Promise<void>,
  endpointAllowsMature?: boolean,
) {
  return new ProductionSoloTurnRunner(
    queryDb as Pool,
    undefined,
    'record',
    join(dir, `${randomUUID()}.ndjson`),
    narrator(calls, beforeNarration),
    false,
    endpointAllowsMature,
  );
}

async function turn(
  sessionId: string,
  accountId: string,
  queryDb: Pick<Pool, 'query'>,
  calls: LlmRequest[],
  beforeNarration?: () => Promise<void>,
  endpointAllowsMature = true,
) {
  const result = await runner(
    queryDb,
    calls,
    beforeNarration,
    endpointAllowsMature,
  ).run(
    {
      sessionId,
      accountId,
      actionId: randomUUID(),
      text: 'We look around.',
      state: {},
    },
    () => undefined,
  );
  const changes = result.events.filter(
    (e) => (e as { type?: string }).type === 'ContentTierChanged',
  ) as { from: string; to: string }[];
  return { result, changes };
}

/** What Room's turn commit does: persist the turn's events, including the tier change, under the session lease. */
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

const storedTier = async (sessionId: string) =>
  (
    await db.query<{ content_tier: string }>(
      'SELECT content_tier FROM sessions WHERE id=$1',
      [sessionId],
    )
  ).rows[0]?.content_tier;

const promptTier = (calls: LlmRequest[]) => {
  const text = JSON.stringify(calls[0]);
  return text.includes('\\"contentTier\\":\\"mature\\"')
    ? 'mature'
    : 'standard';
};

beforeAll(async () => {
  db = new Pool({ connectionString: databaseUrl });
  dir = await mkdtemp(join(tmpdir(), 'content-tier-'));
});
afterAll(async () => {
  await db.end();
  await rm(dir, { recursive: true, force: true });
});

describe('content tier through the DM turn path', () => {
  it('uses mature and emits one ContentTierChanged when every condition holds', async () => {
    const { accountId, sessionId } = await table();
    const calls: LlmRequest[] = [];
    const { result, changes } = await turn(sessionId, accountId, db, calls);
    expect(changes).toEqual([
      { type: 'ContentTierChanged', from: 'standard', to: 'mature' },
    ]);
    expect(result.events[0]).toMatchObject({ type: 'ContentTierChanged' });
    await commit(sessionId, changes);
    expect(await storedTier(sessionId)).toBe('mature');
    expect(promptTier(calls)).toBe('mature');
  });

  it('honors an opt-out that lands between round open and narration', async () => {
    const { accountId, sessionId } = await table();
    const calls: LlmRequest[] = [];
    const { changes } = await turn(
      sessionId,
      accountId,
      hookedDb(() => setOptOut(accountId, true)),
      calls,
    );
    expect(changes).toEqual([]);
    expect(promptTier(calls)).toBe('standard');
    expect(await storedTier(sessionId)).toBe('standard');
  });

  it('keeps the tier snapshot for an in-flight narration and applies an opt-out on the next one', async () => {
    const { accountId, sessionId } = await table();
    const first: LlmRequest[] = [];
    const firstRun = await turn(sessionId, accountId, db, first, () =>
      setOptOut(accountId, true),
    );
    expect(promptTier(first)).toBe('mature');
    await commit(sessionId, firstRun.changes);

    const second: LlmRequest[] = [];
    const secondRun = await turn(sessionId, accountId, db, second);
    expect(promptTier(second)).toBe('standard');
    expect(secondRun.changes).toEqual([
      { type: 'ContentTierChanged', from: 'mature', to: 'standard' },
    ]);
    await commit(sessionId, secondRun.changes);
    expect(await storedTier(sessionId)).toBe('standard');
  });

  it('emits ContentTierChanged once per actual change and never on no change', async () => {
    const { accountId, sessionId } = await table();
    const emitted: unknown[] = [];
    const step = async () => {
      const { changes } = await turn(sessionId, accountId, db, []);
      emitted.push(...changes);
      await commit(sessionId, changes);
    };
    await step();
    await step();
    await setOptOut(accountId, true);
    await step();
    await step();
    await setOptOut(accountId, false);
    await step();
    expect(emitted).toEqual([
      { type: 'ContentTierChanged', from: 'standard', to: 'mature' },
      { type: 'ContentTierChanged', from: 'mature', to: 'standard' },
      { type: 'ContentTierChanged', from: 'standard', to: 'mature' },
    ]);
    const persisted = await db.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM events WHERE session_id=$1 AND type='ContentTierChanged'`,
      [sessionId],
    );
    expect(persisted.rows[0]?.n).toBe('3');
  });

  it('keeps the prompt tier equal to the persisted tier', async () => {
    const { accountId, sessionId } = await table();
    const calls: LlmRequest[] = [];
    const { changes } = await turn(sessionId, accountId, db, calls);
    await commit(sessionId, changes);
    expect(promptTier(calls)).toBe(await storedTier(sessionId));
  });

  it('is standard with zero seated accounts even when moderation and endpoint pass', async () => {
    const { accountId, sessionId } = await table({ seated: false });
    const calls: LlmRequest[] = [];
    const { changes } = await turn(sessionId, accountId, db, calls);
    expect(changes).toEqual([]);
    expect(promptTier(calls)).toBe('standard');
  });

  it('defaults endpoint_allows_mature to false, so mature stays unreachable', async () => {
    const { accountId, sessionId } = await table();
    const calls: LlmRequest[] = [];
    const { changes } = await turn(
      sessionId,
      accountId,
      db,
      calls,
      undefined,
      false,
    );
    expect(changes).toEqual([]);
    expect(promptTier(calls)).toBe('standard');
  });

  it('keeps standard while moderation is unverified', async () => {
    const { accountId, sessionId } = await table({ verified: false });
    const calls: LlmRequest[] = [];
    const { changes } = await turn(sessionId, accountId, db, calls);
    expect(changes).toEqual([]);
    expect(promptTier(calls)).toBe('standard');
  });
});

const promptTierOf = (calls: LlmRequest[]) =>
  JSON.stringify(calls[0]).match(/contentTier\\":\\"(\w+)\\"/)?.[1];

async function hostCap(sessionId: string, accountId: string, tier: unknown) {
  const app = createApp(
    db,
    { inputGate: allowInputGate, cookieSecret: 'test-secret' },
    { inputGate: allowInputGate },
  );
  try {
    const token = await createSession(db, accountId, 'Host device');
    return await app.inject({
      method: 'PATCH',
      url: `/api/sessions/${sessionId}/content-tier`,
      remoteAddress: '10.9.2.1',
      headers: { cookie: `sid=${token}` },
      payload: { tier },
    });
  } finally {
    await app.close();
  }
}

describe('host tier cap through the DM turn path', () => {
  it('holds a host lower through the next narration and does not overwrite it', async () => {
    const { accountId, sessionId } = await table();
    const first = await turn(sessionId, accountId, db, []);
    await commit(sessionId, first.changes);
    expect(await storedTier(sessionId)).toBe('mature');

    expect((await hostCap(sessionId, accountId, 'family')).statusCode).toBe(
      200,
    );

    const calls: LlmRequest[] = [];
    const lowered = await turn(sessionId, accountId, db, calls);
    expect(lowered.changes).toEqual([
      { type: 'ContentTierChanged', from: 'mature', to: 'family' },
    ]);
    expect(promptTierOf(calls)).toBe('family');
    await commit(sessionId, lowered.changes);
    expect(await storedTier(sessionId)).toBe('family');

    const again: LlmRequest[] = [];
    const next = await turn(sessionId, accountId, db, again);
    expect(next.changes).toEqual([]);
    expect(promptTierOf(again)).toBe('family');
    expect(await storedTier(sessionId)).toBe('family');
  });

  it('returns the table to the automatic tier when the host clears the cap', async () => {
    const { accountId, sessionId } = await table();
    expect((await hostCap(sessionId, accountId, 'family')).statusCode).toBe(
      200,
    );
    const low = await turn(sessionId, accountId, db, []);
    await commit(sessionId, low.changes);
    expect(await storedTier(sessionId)).toBe('family');

    expect((await hostCap(sessionId, accountId, null)).statusCode).toBe(200);
    const calls: LlmRequest[] = [];
    const back = await turn(sessionId, accountId, db, calls);
    expect(back.changes).toEqual([
      { type: 'ContentTierChanged', from: 'family', to: 'mature' },
    ]);
    expect(promptTierOf(calls)).toBe('mature');
    await commit(sessionId, back.changes);
    expect(await storedTier(sessionId)).toBe('mature');
  });

  it('never lets a host cap raise the tier, and a player opt-out still lowers it', async () => {
    const { accountId, sessionId } = await table();
    expect((await hostCap(sessionId, accountId, 'standard')).statusCode).toBe(
      200,
    );
    const eligible: LlmRequest[] = [];
    const capped = await turn(sessionId, accountId, db, eligible);
    expect(capped.changes).toEqual([]);
    expect(promptTierOf(eligible)).toBe('standard');

    await setOptOut(accountId, true);
    const optedOut: LlmRequest[] = [];
    expect((await turn(sessionId, accountId, db, optedOut)).changes).toEqual(
      [],
    );
    expect(promptTierOf(optedOut)).toBe('standard');

    await setOptOut(accountId, false);
    const cleared: LlmRequest[] = [];
    expect((await turn(sessionId, accountId, db, cleared)).changes).toEqual([]);
    expect(promptTierOf(cleared)).toBe('standard');
  });
});

describe('writeTurn persists the committed tier change', () => {
  it('updates sessions.content_tier only when the event differs from the stored value', async () => {
    const { sessionId } = await table();
    await commit(sessionId, [
      { type: 'ContentTierChanged', from: 'standard', to: 'mature' },
    ]);
    expect(await storedTier(sessionId)).toBe('mature');
    await commit(sessionId, [
      { type: 'ContentTierChanged', from: 'mature', to: 'mature' },
    ]);
    expect(await storedTier(sessionId)).toBe('mature');
  });
});
