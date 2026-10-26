import { allowInputGate } from '../support/allowInputGate.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createApp } from '../../src/app.js';
import { registerSessionRoutes } from '../../src/routes/sessions.js';
import { SAFE_RECAP_FALLBACK } from '../../src/dm/recap.js';
import type { LlmAdapter } from '../../src/llm/adapter.js';

let caller = 'joiner';
vi.mock('../../src/middleware/auth.js', () => ({
  authenticateRequest: async () => ({ account_id: caller }),
}));
vi.mock('../../src/safety/tierLoader.js', () => ({
  loadContentTierState: async () => ({ tier: 'standard' }),
  loadSeatedContentBoundaries: async () => ({
    lines: ['no spiders'],
    veils: [],
  }),
}));

const requestId = randomUUID();
const sessionId = randomUUID();
const moderate = vi.fn();
let summaries: string[];
let bindings: { name: string | null; redacted: boolean }[];
let pendingOwner: string;
let gameState: unknown;
let adapter: LlmAdapter | undefined;
let queries: string[];

const db = {
  query: async (sql: string) => {
    queries.push(sql);
    if (sql.includes('FROM session_seat_characters'))
      return { rows: bindings, rowCount: bindings.length };
    if (sql.includes('FROM scene_summaries'))
      return { rows: summaries.map((text) => ({ text })), rowCount: 1 };
    if (sql.includes('FROM registry_entries'))
      return { rows: [{ text: 'location Well: dry and old' }], rowCount: 1 };
    if (sql.includes('FROM sessions WHERE id'))
      return {
        rows: [{ content_tier: 'standard', host_tier_cap: null }],
        rowCount: 1,
      };
    if (sql.includes('FROM accounts WHERE id'))
      return {
        rows: [{ content_lines: ['no spiders'], content_veils: [] }],
        rowCount: 1,
      };
    return { rows: [], rowCount: 0 };
  },
} as never;

function build() {
  const rooms = {
    get: async () => undefined,
    getByLateJoinRequestId: async (id: string) =>
      id === requestId
        ? {
            state: {
              sessionId,
              gameState,
              lateJoinRequests: [
                {
                  requestId,
                  accountId: pendingOwner,
                  displayName: 'J',
                  matureOptOut: false,
                },
              ],
            },
          }
        : undefined,
  };
  const app = createApp(db, { inputGate: allowInputGate });
  registerSessionRoutes(
    app as never,
    db as never,
    rooms as never,
    10,
    {},
    { moderator: { moderate } as never, adapter: async () => adapter },
  );
  return app;
}
const get = (app: ReturnType<typeof build>, id = requestId) =>
  app.inject({ method: 'GET', url: `/api/late-join/${id}/recap` });
const llm = (text: string | Error): LlmAdapter =>
  ({
    complete: async function* () {
      if (text instanceof Error) throw text;
      yield { type: 'text', delta: text };
    },
  }) as never;

beforeEach(() => {
  caller = 'joiner';
  pendingOwner = 'joiner';
  gameState = undefined;
  summaries = ['Scene 1: The party crossed the hollow and met the warden.'];
  bindings = [{ name: 'Brann', redacted: false }];
  adapter = undefined;
  queries = [];
  moderate.mockReset();
  moderate.mockResolvedValue({ verdict: 'allow' });
});

describe('GET /api/late-join/:requestId/recap', () => {
  it('returns a <=150-word recap plus table settings to the pending owner', async () => {
    adapter = llm(Array.from({ length: 400 }, (_, i) => `w${i}`).join(' '));
    const res = await get(build());
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.recap.split(' ').length).toBeLessThanOrEqual(150);
    expect(body.settings).toMatchObject({
      contentTier: 'standard',
      lines: ['no spiders'],
    });
  });

  it('is owner-only: another account and unknown ids get the same neutral 404', async () => {
    const app = build();
    caller = 'someone-else';
    expect((await get(app)).statusCode).toBe(404);
    caller = 'joiner';
    expect((await get(app, randomUUID())).statusCode).toBe(404);
    expect((await get(app, 'not-a-uuid')).statusCode).toBe(404);
    expect(moderate).not.toHaveBeenCalled();
  });

  it('excludes chat/events/hidden rows by query and scrubs names and quotes', async () => {
    summaries = [
      'Scene 1: Brann said "the key is under the stone" to the warden.',
    ];
    const body = (await get(build())).json();
    expect(body.recap).not.toMatch(/Brann|under the stone/);
    const sql = queries.join('\n');
    expect(sql).not.toMatch(/FROM events|chat/i);
    expect(sql).toContain("entity_type IN ('npc','location','quest')");
  });

  it('drops scene summaries when a deleted player left a redacted binding', async () => {
    bindings = [{ name: 'Deleted player', redacted: true }];
    summaries = ['Scene 1: Orlo killed the warden.'];
    const body = (await get(build())).json();
    expect(body.recap).not.toContain('Orlo');
    expect(queries.join('\n')).not.toContain('FROM scene_summaries');
  });

  it('scrubs a character name the LLM itself emits (post-LLM scrub)', async () => {
    adapter = llm('Brann opened the gate while Brann smiled.');
    const body = (await get(build())).json();
    expect(body.recap).not.toMatch(/Brann/);
    expect(body.recap).toContain('a party member');
  });

  it('keys the cache by account as well as request', async () => {
    const app = build();
    adapter = llm('Owner recap.');
    expect((await get(app)).statusCode).toBe(200);
    caller = 'someone-else';
    const res = await get(app);
    expect(res.statusCode).toBe(404);
    expect(res.json()).not.toHaveProperty('recap');
  });

  it('a newer concealment invalidates the cached recap', async () => {
    const app = build();
    adapter = llm('Gribble waits.');
    await get(app);
    await get(app);
    expect(moderate).toHaveBeenCalledTimes(1);
    gameState = { concealed: [{ id: 'ent_gob', name: 'Gribble' }] };
    const body = (await get(app)).json();
    expect(moderate).toHaveBeenCalledTimes(2);
    expect(body.recap).not.toMatch(/Gribble/);
  });

  it('falls back to deterministic text when the LLM fails', async () => {
    adapter = llm(new Error('down'));
    const res = await get(build());
    expect(res.statusCode).toBe(200);
    expect(res.json().recap).toContain('warden');
  });

  it('never returns raw text when the moderation gate blocks or is down', async () => {
    moderate.mockResolvedValue({ verdict: 'block' });
    expect((await get(build())).json().recap).toBe(SAFE_RECAP_FALLBACK);
    moderate.mockRejectedValue(new Error('outage'));
    expect((await get(build())).json().recap).toBe(SAFE_RECAP_FALLBACK);
  });

  it('is idempotent for retries and rate limited per account', async () => {
    const app = build();
    adapter = llm('A recap.');
    const first = (await get(app)).json();
    adapter = llm('Different.');
    expect((await get(app)).json()).toEqual(first);
    expect(moderate).toHaveBeenCalledTimes(1);
    let last = 200;
    for (let i = 0; i < 6; i++) last = (await get(app)).statusCode;
    expect(last).toBe(429);
  });
});
