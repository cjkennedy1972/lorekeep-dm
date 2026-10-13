import { describe, expect, it } from 'vitest';
import type { LlmAdapter, LlmChunk } from '../../src/llm/adapter.js';
import {
  buildRecap,
  assembleDeterministicRecap,
  gateRecap,
  MAX_RECAP_WORDS,
  SAFE_RECAP_FALLBACK,
} from '../../src/dm/recap.js';
import {
  boundSummary,
  closeScene,
  summarizeScene,
  MAX_SCENE_SUMMARY_WORDS,
} from '../../src/dm/summarize.js';
import type {
  Moderator,
  ModerationRequest,
} from '../../src/safety/moderator.js';
import type { Verdict } from '../../src/safety/moderator.js';

class FixtureAdapter implements LlmAdapter {
  calls = 0;
  constructor(private readonly response: string | Error) {}
  capabilities() {
    return { streaming: true, nativeTools: false, jsonSchema: true };
  }
  async *complete(): AsyncIterable<LlmChunk> {
    this.calls++;
    if (this.response instanceof Error) throw this.response;
    yield { type: 'text', delta: this.response };
  }
  async probe() {
    return true;
  }
}

describe('scene summaries and recap', () => {
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
    );

    expect(result.recap).toBe(SAFE_RECAP_FALLBACK);
    expect(result.fallback).toBe(true);
    expect(result.cached).toBe(false);
    expect(requests[0]).toMatchObject({
      text: 'unsafe generated recap',
      tier: 'standard',
      tableLines: ['line: no spiders'],
      direction: 'output',
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
      ),
    ).toEqual(safeRecap);
  });

  it('does not persist a blocked model-authored scene summary or registry diff', async () => {
    let persistedSummary = '';
    let calls = 0;
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
      async moderate(): Promise<Verdict> {
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
    expect(result.summary).toContain('LocationChanged');
    expect(events).toEqual(before);
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
      },
      changed: true,
      adapter: changedAdapter,
    });
    expect(updated.cached).toBe(false);
    expect(changedAdapter.calls).toBe(1);
  });
});
