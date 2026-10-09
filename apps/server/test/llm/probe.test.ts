import { describe, expect, it } from 'vitest';
import type {
  LlmAdapter,
  LlmCapabilities,
  LlmChunk,
  LlmRequest,
} from '../../src/llm/adapter.js';
import { LlmEndpointError } from '../../src/llm/adapter.js';
import { probeEndpoint } from '../../src/llm/probe.js';
import { ToolModeCircuitBreaker } from '../../src/llm/modes.js';

type Behavior =
  | 'native'
  | 'json-schema'
  | 'neither'
  | 'malformed'
  | 'timeout'
  | 'unauthorized'
  | 'rate-limit'
  | 'server-error';

class FakeEndpoint implements LlmAdapter {
  readonly maxTokens: number[] = [];

  constructor(private readonly behavior: Behavior) {}

  capabilities(): LlmCapabilities {
    return { streaming: true, nativeTools: true, jsonSchema: true };
  }

  async probe(): Promise<boolean> {
    return true;
  }

  async *complete(request: LlmRequest): AsyncIterable<LlmChunk> {
    this.maxTokens.push(request.maxTokens);
    if (this.behavior === 'timeout') {
      throw new LlmEndpointError('endpoint-timeout', 'private timeout details');
    }
    if (
      this.behavior === 'unauthorized' ||
      this.behavior === 'rate-limit' ||
      this.behavior === 'server-error'
    ) {
      const status =
        this.behavior === 'unauthorized'
          ? 401
          : this.behavior === 'rate-limit'
            ? 429
            : 503;
      throw new LlmEndpointError(
        'endpoint-error',
        'private endpoint body',
        status,
      );
    }
    const mode = request.toolMode;
    if (!mode) {
      yield { type: 'text', delta: 'ready' };
      return;
    }
    const user = request.messages.at(-1)?.content ?? '';
    const id = user.match(/scenario-\d+/)?.[0] ?? '';
    if (this.behavior === 'malformed') {
      yield { type: 'text', delta: '{bad json' };
      return;
    }
    if (this.behavior === 'native' && mode === 'native') {
      yield {
        type: 'tool-call',
        id: 'call',
        name: 'probe_capability',
        arguments: { scenarioId: id, accepted: true },
      };
      return;
    }
    if (this.behavior === 'json-schema' && mode === 'json-schema') {
      yield {
        type: 'text',
        delta: JSON.stringify({ scenarioId: id, accepted: true }),
      };
      return;
    }
    yield { type: 'text', delta: 'unsupported' };
  }
}

const options = {
  id: 'profile-1',
  model: 'fake',
  contextWindow: 32_768,
  scenarios: 2,
  now: (() => {
    let n = 0;
    return () => ++n;
  })(),
};

describe('endpoint capability probe', () => {
  it('selects native tools and persists capability facts, unqualified', async () => {
    let persisted: unknown;
    const adapter = new FakeEndpoint('native');
    const profile = await probeEndpoint(adapter, {
      ...options,
      persist: (value) => {
        persisted = value;
      },
    });
    expect(profile.toolMode).toBe('native');
    expect(profile.capabilities.nativeTools.supported).toBe(true);
    expect(profile.capabilities.contextWindow32k.supported).toBe(true);
    expect(profile.capabilities.streaming.supported).toBe(true);
    expect(profile.capabilities.streaming.detail).toBeUndefined();
    expect(adapter.maxTokens).toEqual([2_048, 2_048, 2_048, 2_048]);
    expect(profile.ttftMs).not.toBeNull();
    expect(profile.qualified).toBe(false);
    expect(persisted).toEqual(profile);
    expect(JSON.stringify(profile)).not.toContain('scenario-');
  });

  it('selects json-schema when that capability works and native tools do not', async () => {
    const profile = await probeEndpoint(
      new FakeEndpoint('json-schema'),
      options,
    );
    expect(profile.toolMode).toBe('json-schema');
    expect(profile.capabilities.nativeTools.supported).toBe(false);
    expect(profile.capabilities.jsonSchema.supported).toBe(true);
  });

  it('reports unsupported instead of silently falling back when neither works', async () => {
    const profile = await probeEndpoint(new FakeEndpoint('neither'), options);
    expect(profile.toolMode).toBe('unsupported');
    expect(profile.validCallRate).toBe(0);
  });

  it('counts malformed output as schema violations without retaining content', async () => {
    const profile = await probeEndpoint(new FakeEndpoint('malformed'), options);
    expect(profile.schemaViolations).toBe(4);
    expect(JSON.stringify(profile)).not.toContain('bad json');
  });

  it.each(['timeout', 'unauthorized', 'rate-limit', 'server-error'] as const)(
    'fails closed for %s without leaking endpoint details',
    async (failure) => {
      const profile = await probeEndpoint(new FakeEndpoint(failure), options);
      expect(profile.toolMode).toBe('unsupported');
      expect(profile.capabilities.reachability.supported).toBe(false);
      expect(JSON.stringify(profile)).not.toMatch(/private|scenario-/);
    },
  );

  it('stops promptly when the caller aborts', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      probeEndpoint(new FakeEndpoint('native'), {
        ...options,
        signal: controller.signal,
      }),
    ).rejects.toThrow();
  });

  it('stays unqualified unless a separate evaluation qualifies the endpoint', async () => {
    expect(
      (await probeEndpoint(new FakeEndpoint('native'), options)).qualified,
    ).toBe(false);
  });
});

describe('tool mode circuit breaker', () => {
  it('downgrades native after a rolling error-rate breach', () => {
    const breaker = new ToolModeCircuitBreaker('native', 4, 0.25);
    breaker.recordToolResult(true);
    breaker.recordToolResult(false);
    breaker.recordToolResult(false);
    breaker.recordToolResult(true);
    expect(breaker.mode).toBe('json-schema');
    expect(breaker.request({ messages: [], maxTokens: 1 }).toolMode).toBe(
      'json-schema',
    );
  });

  it('downgrades json-schema to unsupported and refuses tool requests', () => {
    const breaker = new ToolModeCircuitBreaker('json-schema', 2, 0);
    breaker.recordToolResult(false);
    breaker.recordToolResult(true);
    expect(breaker.mode).toBe('unsupported');
    expect(() => breaker.request({ messages: [], maxTokens: 1 })).toThrow(
      'no supported tool mode',
    );
  });
});
