import { describe, expect, it, vi } from 'vitest';
import type { LlmAdapter, LlmChunk, LlmRequest } from '../src/llm/adapter.js';
import {
  MeteredLlmAdapter,
  type UsageRecord,
  type UsageSink,
} from '../src/llm/metering.js';

const request: LlmRequest = {
  messages: [{ role: 'user', content: 'private prompt' }],
  maxTokens: 20,
};
class FakeAdapter implements LlmAdapter {
  constructor(
    private readonly chunks: LlmChunk[],
    private readonly failure?: Error,
  ) {}
  capabilities() {
    return { streaming: true, nativeTools: false, jsonSchema: false };
  }
  async *complete() {
    for (const chunk of this.chunks) yield chunk;
    if (this.failure) throw this.failure;
  }
  async probe() {
    return true;
  }
}
const context = {
  sessionId: 'a1f91f84-e02c-4407-81dc-c635dd135049',
  turnId: 'turn-1',
  purpose: 'narration' as const,
  modelId: 'fixture',
  retries: 1,
};
async function collect(adapter: LlmAdapter) {
  for await (const chunk of adapter.complete(request)) {
    void chunk;
  }
}

describe('LLM usage metering', () => {
  it('writes one reported row per adapter invocation including retry count', async () => {
    const rows: UsageRecord[] = [];
    const sink: UsageSink = {
      record: async (row) => {
        rows.push(row);
      },
    };
    const adapter = new MeteredLlmAdapter(
      new FakeAdapter([
        { type: 'text', delta: 'answer' },
        {
          type: 'usage',
          usage: {
            input: 12,
            output: 2,
            cacheRead: 4,
            cacheWrite: 2,
            estimate: false,
          },
        },
      ]),
      sink,
      context,
    );
    await collect(adapter);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      inputTokens: 12,
      outputTokens: 2,
      cachedTokens: 4,
      cacheWriteTokens: 2,
      estimated: false,
      retries: 1,
      errorCode: null,
    });
    expect(JSON.stringify(rows[0])).not.toContain('private prompt');
  });
  it('flags estimated tokens when endpoint usage is absent', async () => {
    const rows: UsageRecord[] = [];
    const adapter = new MeteredLlmAdapter(
      new FakeAdapter([{ type: 'text', delta: 'answer' }]),
      {
        record: async (row) => {
          rows.push(row);
        },
      },
      context,
    );
    await collect(adapter);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      inputTokens: 4,
      outputTokens: 2,
      estimated: true,
    });
  });
  it('records one error row and rethrows the endpoint error', async () => {
    const rows: UsageRecord[] = [];
    const error = Object.assign(new Error('failed'), {
      code: 'endpoint-timeout',
    });
    const adapter = new MeteredLlmAdapter(
      new FakeAdapter([], error),
      {
        record: async (row) => {
          rows.push(row);
        },
      },
      context,
    );
    await expect(collect(adapter)).rejects.toBe(error);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      errorCode: 'endpoint-timeout',
      retries: 1,
      estimated: true,
    });
  });
  it('does not replace the endpoint result when metering storage fails', async () => {
    const onError = vi.fn();
    const adapter = new MeteredLlmAdapter(
      new FakeAdapter([{ type: 'text', delta: 'ok' }]),
      {
        record: async () => {
          throw new Error('db unavailable');
        },
      },
      context,
      onError,
    );
    await expect(collect(adapter)).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledOnce();
  });
});
