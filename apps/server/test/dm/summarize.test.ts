import { describe, expect, it } from 'vitest';
import type {
  LlmAdapter,
  LlmChunk,
} from '../../src/llm/adapter.js';
import {
  buildRecap,
  assembleDeterministicRecap,
  MAX_RECAP_WORDS,
} from '../../src/dm/recap.js';
import {
  boundSummary,
  summarizeScene,
  MAX_SCENE_SUMMARY_WORDS,
} from '../../src/dm/summarize.js';

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
