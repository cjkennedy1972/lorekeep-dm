import { describe, expect, it } from 'vitest';
import type { LlmAdapter, LlmChunk } from '../../src/llm/adapter.js';
import {
  buildRecap,
  assembleDeterministicRecap,
  gateRecap,
  MAX_RECAP_WORDS,
  SAFE_RECAP_FALLBACK,
  buildResumeRecap,
} from '../../src/dm/recap.js';
import {
  boundSummary,
  closeScene,
  summarizeScene,
  MAX_SCENE_SUMMARY_WORDS,
  containsIdentityVariant,
  projectSummarizerEvents,
} from '../../src/dm/summarize.js';
import type {
  Moderator,
  ModerationRequest,
} from '../../src/safety/moderator.js';
import type { Verdict } from '../../src/safety/moderator.js';
import { JudgeBudget } from '../../src/safety/judgeBudget.js';

class FixtureAdapter implements LlmAdapter {
  calls = 0;
  lastRequest?: { messages: { content: string }[] };
  constructor(private readonly response: string | Error) {}
  capabilities() {
    return { streaming: true, nativeTools: false, jsonSchema: true };
  }
  async *complete(request: {
    messages: { content: string }[];
  }): AsyncIterable<LlmChunk> {
    this.lastRequest = request;
    this.calls++;
    if (this.response instanceof Error) throw this.response;
    yield { type: 'text', delta: this.response };
  }
  async probe() {
    return true;
  }
}

describe('scene summaries and recap', () => {
  it('retries once and discards output with unknown opaque tokens', async () => {
    const adapter = new FixtureAdapter(
      JSON.stringify({
        summary: `The event ${'z'.repeat(32)} occurred.`,
        registryDiffs: [],
      }),
    );
    const result = await summarizeScene({
      sceneId: 's1',
      events: [
        { type: 'HpChanged', payload: { entityId: 'ent_1', delta: -1, hp: 9 } },
      ],
      adapter,
      validReferenceTokens: ['a'.repeat(32)],
    });
    expect(adapter.calls).toBe(2);
    expect(result.fallback).toBe(true);
    expect(result.summary).toContain('HpChanged');
    expect(result.summary).not.toContain('z'.repeat(32));
  });
  it('screens Unicode-normalized name fragments and common-word possessives on Unicode boundaries', () => {
    expect(
      containsIdentityVariant('WILL’S lantern glows', ['Will Harper']),
    ).toBe(true);
    expect(containsIdentityVariant('The café is quiet', ['Café'])).toBe(true);
    expect(
      containsIdentityVariant('The unrelated village', ['Will Harper']),
    ).toBe(false);
    expect(containsIdentityVariant('X enters', ['X'])).toBe(true);
  });

  it('rejects unknown fields and free-text event types from the summarizer projection', () => {
    expect(
      projectSummarizerEvents([
        {
          type: 'ConditionApplied',
          payload: {
            entityId: 'ent_1',
            conditionId: 'prone',
            source: 'PLAYER QUOTE',
          },
        },
        { type: 'SeatJoined', payload: { displayName: 'A Name' } },
      ]),
    ).toEqual([]);
  });
  it('sends only exact allowlisted event fields to the summarizer and fallback', async () => {
    const adapter = new FixtureAdapter(
      JSON.stringify({ summary: 'A turn resolved.', registryDiffs: [] }),
    );
    const result = await summarizeScene({
      sceneId: 's1',
      events: [
        {
          type: 'InitiativeRolled',
          payload: { type: 'InitiativeRolled', entityId: 'ent_1', total: 12 },
        },
        {
          type: 'HpChanged',
          payload: {
            entityId: 'ent_1',
            delta: -2,
            hp: 8,
            playerText: 'NEVER_FORWARD_THIS',
          },
        },
        {
          type: 'TurnOpened',
          payload: {
            type: 'TurnOpened',
            turnId: '11111111-1111-4111-8111-111111111111',
            entityId: 'ent_1',
            deadline: 123,
          },
        },
        {
          type: 'SeatJoined',
          payload: {
            seatId: 'seat_1',
            displayName: 'NEVER_FORWARD_NAME',
            accountId: 'account_1',
          },
        },
      ],
      adapter,
    });
    const request = (
      adapter as unknown as {
        lastRequest?: { messages: { content: string }[] };
      }
    ).lastRequest;
    expect(
      request?.messages.map((message) => message.content).join(' '),
    ).not.toContain('NEVER_FORWARD');
    expect(
      request?.messages.map((message) => message.content).join(' '),
    ).toContain('InitiativeRolled');
    expect(
      request?.messages.map((message) => message.content).join(' '),
    ).not.toContain('SeatJoined');
    expect(result.summary).toBe('A turn resolved.');
  });
  it('replaces a blocked or unavailable recap with authored safe text', async () => {
    const requests: ModerationRequest[] = [];
    const moderator: Moderator = {
      async moderate(request) {
        requests.push(request);
        return {
          verdict: 'block',
          category: 'other',
          source: 'failclosed',
          failClosedRow: 'hard-floor',
          latencyMs: 0,
          unavailable: true,
        };
      },
    };
    const result = await gateRecap(
      {
        recap: 'unsafe generated recap',
        memoryHash: 'hash',
        cached: true,
        fallback: false,
      },
      moderator,
      'standard',
      ['line: no spiders'],
      'table-for-recap',
    );

    expect(result.recap).toBe(SAFE_RECAP_FALLBACK);
    expect(result.fallback).toBe(true);
    expect(result.cached).toBe(false);
    expect(requests[0]).toMatchObject({
      text: 'unsafe generated recap',
      tier: 'standard',
      tableLines: ['line: no spiders'],
      direction: 'output',
      sessionId: 'table-for-recap',
    });

    const safeRecap = {
      recap: 'The lantern leads toward the old bridge.',
      memoryHash: 'safe-hash',
      cached: false,
      fallback: false,
    };
    expect(
      await gateRecap(
        safeRecap,
        {
          async moderate() {
            return {
              verdict: 'allow',
              category: 'none',
              source: 'judge',
              latencyMs: 0,
              unavailable: false,
            };
          },
        },
        'standard',
        [],
        'table-for-recap',
      ),
    ).toEqual(safeRecap);
  });

  it('keeps recap and scene-close output capacity isolated by table', async () => {
    const budget = new JudgeBudget();
    const requests: ModerationRequest[] = [];
    const moderator: Moderator = {
      async moderate(request) {
        requests.push(request);
        const slot = budget.acquire('output', 1_000, request.sessionId);
        if (slot.kind === 'limited')
          return {
            verdict: 'block',
            category: 'other',
            source: 'failclosed',
            latencyMs: 0,
            unavailable: true,
            failClosedRow: 'tier',
          };
        slot.release();
        return {
          verdict: 'allow',
          category: 'none',
          source: 'judge',
          latencyMs: 0,
          unavailable: false,
        };
      },
    };
    const recap = {
      recap: 'The party reaches the observatory.',
      memoryHash: 'hash',
      cached: false,
      fallback: false,
    };
    for (let call = 0; call < 60; call++)
      await gateRecap(recap, moderator, 'standard', [], 'table-a');

    const otherTableRecap = await gateRecap(
      recap,
      moderator,
      'standard',
      [],
      'table-b',
    );
    expect(otherTableRecap.fallback).toBe(false);

    const db = {
      async query() {
        return { rows: [], rowCount: 0 };
      },
      async connect() {
        return {
          async query() {
            return { rows: [], rowCount: 1 };
          },
          release() {},
        };
      },
    } as never;
    const closed = await closeScene({
      sessionId: 'table-b',
      sceneId: 'scene-b',
      events: [],
      db,
      moderator,
      tier: 'standard',
      tableLines: [],
      adapter: new FixtureAdapter(
        JSON.stringify({
          summary: 'The party reaches the observatory.',
          registryDiffs: [],
        }),
      ),
    });
    expect(closed.summary).toBe('The party reaches the observatory.');
    expect(requests.slice(-2).map((request) => request.sessionId)).toEqual([
      'table-b',
      'table-b',
    ]);
  });

  it('does not persist a blocked model-authored scene summary or registry diff', async () => {
    let persistedSummary = '';
    let calls = 0;
    const moderationRequests: ModerationRequest[] = [];
    const db = {
      async query() {
        return { rows: [], rowCount: 0 };
      },
      async connect() {
        return {
          async query(sql: string, params: unknown[] = []) {
            calls++;
            if (sql.includes('INSERT INTO scene_summaries')) {
              persistedSummary = String(params[2]);
              return { rows: [], rowCount: 1 };
            }
            return { rows: [], rowCount: 0 };
          },
          release() {},
        };
      },
    } as never;
    const moderator: Moderator = {
      async moderate(request: ModerationRequest): Promise<Verdict> {
        moderationRequests.push(request);
        return {
          verdict: 'block',
          category: 'violence',
          source: 'judge',
          latencyMs: 1,
          unavailable: false,
        };
      },
    };
    const result = await closeScene({
      sessionId: 'session-1',
      sceneId: 'scene-1',
      events: [],
      db,
      moderator,
      tier: 'standard',
      tableLines: [],
      adapter: new FixtureAdapter(
        JSON.stringify({
          summary: 'Unsafe graphic gore.',
          registryDiffs: [
            {
              kind: 'ruling',
              id: 'ruling_x',
              after: { id: 'ruling_x', topic: 'x', ruling: 'Unsafe detail.' },
            },
          ],
        }),
      ),
    });

    expect(result.summary).toBe('The scene has ended.');
    expect(result.registryDiffs).toEqual([]);
    expect(result.fallback).toBe(true);
    expect(persistedSummary).toBe('The scene has ended.');
    expect(moderationRequests).toHaveLength(1);
    expect(moderationRequests[0]).toMatchObject({
      direction: 'output',
      sessionId: 'session-1',
    });
    expect(calls).toBe(3); // BEGIN, INSERT safe summary, COMMIT
  });

  it('bounds a summary by both word and character limits', () => {
    const value = boundSummary(
      Array.from({ length: 200 }, (_, i) => `w${i}`).join(' '),
    );
    expect(value.split(/\s+/)).toHaveLength(MAX_SCENE_SUMMARY_WORDS);
    expect(value.length).toBeLessThanOrEqual(1200);
  });

  it('uses the adapter and rejects unvalidated registry-diff shapes', async () => {
    const adapter = new FixtureAdapter(
      JSON.stringify({
        summary: 'The party reached the archive.',
        registryDiffs: [
          {
            kind: 'npc',
            id: 'npc_x',
            after: {
              id: 'npc_x',
              name: 'Lyra Vale',
              role: 'archivist',
              disposition: 'friendly',
              facts: ['Guards the archive.'],
            },
          },
          { kind: 'sql', id: 'bad', after: {} },
        ],
      }),
    );
    const result = await summarizeScene({ sceneId: 's1', events: [], adapter });
    expect(adapter.calls).toBe(1);
    expect(result).toEqual({
      summary: 'The party reached the archive.',
      registryDiffs: [
        {
          kind: 'npc',
          id: 'npc_x',
          after: {
            id: 'npc_x',
            name: 'Lyra Vale',
            role: 'archivist',
            disposition: 'friendly',
            facts: ['Guards the archive.'],
          },
        },
      ],
      fallback: false,
    });
  });

  it('drops registry diffs with malformed alias or supersession metadata', async () => {
    const adapter = new FixtureAdapter(
      JSON.stringify({
        summary: 'The party meets Lyra.',
        registryDiffs: [
          {
            kind: 'npc',
            id: 'npc_unsafe_alias',
            aliases: [42],
            after: {
              id: 'npc_unsafe_alias',
              name: 'Lyra Vale',
              role: 'archivist',
              disposition: 'friendly',
              facts: [],
            },
          },
          {
            kind: 'npc',
            id: 'npc_unsafe_supersession',
            supersedesFacts: null,
            after: {
              id: 'npc_unsafe_supersession',
              name: 'Mira Vale',
              role: 'archivist',
              disposition: 'friendly',
              facts: [],
            },
          },
        ],
      }),
    );

    const result = await summarizeScene({
      sceneId: 's1',
      events: [],
      adapter,
    });

    expect(result.summary).toBe('The party meets Lyra.');
    expect(result.registryDiffs).toEqual([]);
    expect(result.fallback).toBe(false);
  });

  it('moderates registry aliases and supersession text before persisting diffs', async () => {
    let persistedRegistryEntries = 0;
    const db = {
      async query() {
        return { rows: [], rowCount: 0 };
      },
      async connect() {
        return {
          async query(sql: string) {
            if (sql.includes('INSERT INTO scene_summaries'))
              return { rows: [], rowCount: 1 };
            if (sql.includes('INSERT INTO registry_entries'))
              persistedRegistryEntries++;
            return { rows: [], rowCount: 0 };
          },
          release() {},
        };
      },
    } as never;
    const moderated: string[] = [];
    const moderator: Moderator = {
      async moderate(request) {
        moderated.push(request.text);
        return {
          verdict: request.text.includes('Veiled Alias') ? 'block' : 'allow',
          category: request.text.includes('Veiled Alias') ? 'violence' : 'none',
          source: 'judge',
          latencyMs: 1,
          unavailable: false,
        };
      },
    };
    const result = await closeScene({
      sessionId: 'session-1',
      sceneId: 'scene-1',
      events: [],
      db,
      moderator,
      tier: 'standard',
      tableLines: [],
      adapter: new FixtureAdapter(
        JSON.stringify({
          summary: 'The party meets Lyra.',
          registryDiffs: [
            {
              kind: 'npc',
              id: 'npc_lyra',
              aliases: ['Veiled Alias'],
              after: {
                id: 'npc_lyra',
                name: 'Lyra Vale',
                role: 'archivist',
                disposition: 'friendly',
                facts: [],
              },
            },
          ],
        }),
      ),
    });

    expect(moderated).toEqual([
      'The party meets Lyra.',
      expect.stringContaining('Veiled Alias'),
    ]);
    expect(result.registryDiffs).toEqual([]);
    expect(result.fallback).toBe(true);
    expect(persistedRegistryEntries).toBe(0);
  });

  it('falls back deterministically when the endpoint fails, without mutating event input', async () => {
    const events = [
      { type: 'LocationChanged', payload: { name: 'Silver Archive' } },
    ];
    const before = structuredClone(events);
    const result = await summarizeScene({
      sceneId: 's1',
      events,
      adapter: new FixtureAdapter(new Error('offline')),
    });
    expect(result.fallback).toBe(true);
    expect(result.registryDiffs).toEqual([]);
    expect(result.summary).toBe(
      'The scene closed without additional recorded events.',
    );
    expect(events).toEqual(before);
  });

  it('returns no recap for a new game, ignoring prior snapshot text and raw events', async () => {
    const adapter = new FixtureAdapter('secret key location');
    const db = {
      query: async () => ({ rows: [], rowCount: 0 }),
      connect: async () => {
        throw new Error('unused');
      },
    } as never;
    const result = await buildResumeRecap({
      db,
      sessionId: 'new-game',
      lastEvents: [
        {
          type: 'GameStarted',
          summary: 'The hidden key is beneath the throne.',
        },
      ],
      previousSnapshotRecap: {
        recap: 'The hidden key is beneath the throne.',
        memoryHash: 'old',
      },
      adapter,
    });
    expect(result.recap).toBe('');
    expect(adapter.calls).toBe(0);
  });

  it('builds resume recap only from scene summaries, never registry facts or raw events', async () => {
    const queries: string[] = [];
    const db = {
      query: async (sql: string) => {
        queries.push(sql);
        return {
          rows: sql.includes("type='NarrationCompleted'")
            ? [{ narration: 'The party reached the bridge.' }]
            : [],
          rowCount: 1,
        };
      },
      connect: async () => {
        throw new Error('unused');
      },
    } as never;
    const adapter = new FixtureAdapter('The party reached the bridge.');
    const result = await buildResumeRecap({
      db,
      sessionId: 'existing-game',
      lastEvents: [
        { type: 'SecretDiscovered', summary: 'The boss wears the key.' },
      ],
      adapter,
    });
    expect(result.recap).toBe('The party reached the bridge.');
    expect(queries.join(' ')).not.toContain('registry_entries');
    expect(adapter.calls).toBe(1);
  });

  it('assembles recap within the word limit and reuses unchanged snapshot recap without calling the adapter', async () => {
    const memories = [
      Array.from({ length: 200 }, (_, i) => `fact${i}`).join(' '),
    ];
    const recap = assembleDeterministicRecap(memories);
    expect(recap.split(/\s+/).length).toBeLessThanOrEqual(MAX_RECAP_WORDS);
    const adapter = new FixtureAdapter(new Error('should not be called'));
    const first = await buildRecap({ memories });
    const second = await buildRecap({
      memories,
      previousSnapshotRecap: {
        recap: first.recap,
        memoryHash: first.memoryHash,
        provenanceVersion: 2,
      },
      adapter,
    });
    expect(second.cached).toBe(true);
    expect(adapter.calls).toBe(0);
    const changedAdapter = new FixtureAdapter('A revised recap.');
    const updated = await buildRecap({
      memories,
      previousSnapshotRecap: {
        recap: first.recap,
        memoryHash: first.memoryHash,
        provenanceVersion: 2,
      },
      changed: true,
      adapter: changedAdapter,
    });
    expect(updated.cached).toBe(false);
    expect(changedAdapter.calls).toBe(1);
  });
});
