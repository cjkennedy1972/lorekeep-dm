import { describe, expect, it } from 'vitest';
import { LlmEndpointError, type LlmChunk } from '../../src/llm/adapter.js';
import { isMatureRefusal, watchMatureRefusal } from '../../src/llm/refusal.js';

describe('isMatureRefusal', () => {
  it.each([400, 401, 403])(
    'does not treat a bodyless endpoint HTTP %i as a refusal',
    (status) => {
      expect(
        isMatureRefusal(new LlmEndpointError('endpoint-error', 'x', status)),
      ).toBe(false);
    },
  );

  it.each([
    ['a rate limit', new LlmEndpointError('endpoint-error', 'x', 429)],
    ['a server error', new LlmEndpointError('endpoint-error', 'x', 500)],
    ['a timeout', new LlmEndpointError('endpoint-timeout', 'x', 403)],
    ['an aborted stream', new LlmEndpointError('stream-aborted', 'x')],
    ['a plain error', new Error('refused')],
  ])('does not match %s', (_, error) => {
    expect(isMatureRefusal(error)).toBe(false);
  });
});

describe('watchMatureRefusal', () => {
  it('rethrows a bodyless 403 without reporting a refusal', async () => {
    let refused = false;
    async function* refusing(): AsyncIterable<LlmChunk> {
      throw new LlmEndpointError('endpoint-error', 'x', 403);
    }
    const drain = async () => {
      for await (const _ of watchMatureRefusal(refusing(), () => {
        refused = true;
      }));
    };
    await expect(drain()).rejects.toThrow('x');
    expect(refused).toBe(false);
  });

  it('passes chunks through without reporting when nothing fails', async () => {
    let refused = false;
    async function* ok(): AsyncIterable<LlmChunk> {
      yield { type: 'text', delta: 'hi' };
    }
    const chunks: LlmChunk[] = [];
    for await (const chunk of watchMatureRefusal(ok(), () => {
      refused = true;
    }))
      chunks.push(chunk);
    expect(chunks).toEqual([{ type: 'text', delta: 'hi' }]);
    expect(refused).toBe(false);
  });
});
