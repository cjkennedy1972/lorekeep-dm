import { afterEach, describe, expect, it } from 'vitest';
import { LlmEndpointError } from '../../src/llm/adapter.js';
import { createEgressGuard } from '../../src/llm/egress.js';
import { RecordedLlmAdapter } from '../../src/llm/recorded.js';
import { Secret } from '../../src/llm/secret.js';
import { AnthropicMessagesAdapter } from '../../src/llm/dialects/anthropic.js';
import {
  anthropicStream,
  startFakeAnthropicServer,
  type FakeAnthropicServer,
} from './fakeAnthropicServer.js';

describe('Anthropic Messages adapter', () => {
  let server: FakeAnthropicServer | undefined;
  afterEach(async () => {
    await server?.close();
    server = undefined;
  });
  const adapterFor = (cache = false, timeoutMs = 500) => {
    if (!server) throw new Error('fake endpoint not started');
    return new AnthropicMessagesAdapter({
      baseUrl: server.baseUrl,
      model: 'fixture-model',
      apiKey: new Secret('test-secret'),
      cache,
      egress: createEgressGuard({
        allowLocalHosts: ['127.0.0.1', 'localhost'],
      }),
      timeoutMs,
    });
  };
  const request = {
    messages: [
      { role: 'system' as const, content: 'stable rules' },
      { role: 'user' as const, content: 'private prompt' },
    ],
    maxTokens: 10,
    toolMode: 'native' as const,
    tools: [
      {
        name: 'request_check',
        description: 'check',
        parameters: { type: 'object' },
      },
    ],
    cacheHints: { stablePrefixMessages: 1 },
  };
  const collect = async (adapter: AnthropicMessagesAdapter) => {
    const chunks = [];
    for await (const chunk of adapter.complete(request)) chunks.push(chunk);
    return chunks;
  };
  it('maps messages, tools, streams text/tool input and maps cache usage', async () => {
    server = await startFakeAnthropicServer({ chunks: anthropicStream });
    const chunks = await collect(adapterFor(true));
    expect(chunks.filter((c) => c.type === 'text')).toEqual([
      { type: 'text', delta: 'hello ' },
      { type: 'text', delta: 'world' },
    ]);
    expect(chunks.find((c) => c.type === 'tool-call')).toEqual({
      type: 'tool-call',
      id: 'tool_1',
      name: 'request_check',
      arguments: { dc: 15, ability: 'dex' },
    });
    expect(chunks.at(-1)).toEqual({
      type: 'usage',
      usage: {
        input: 10,
        output: 4,
        cacheRead: 3,
        cacheWrite: 2,
        estimate: false,
      },
    });
    expect(server.requests[0]?.headers['anthropic-version']).toBe('2023-06-01');
    expect(server.requests[0]?.headers['x-api-key']).toBe('[REDACTED]');
    expect(JSON.stringify(server.requests[0])).not.toContain('private prompt');
    expect(server.requests[0]?.body).toMatchObject({
      system: [
        {
          type: 'text',
          text: 'stable rules',
          cache_control: { type: 'ephemeral' },
        },
      ],
      tools: [
        {
          name: 'request_check',
          input_schema: { type: 'object' },
          cache_control: { type: 'ephemeral' },
        },
      ],
    });
  });
  it('omits cache markers unless profile caching is enabled', async () => {
    server = await startFakeAnthropicServer({ chunks: anthropicStream });
    await collect(adapterFor(false));
    expect(JSON.stringify(server.requests[0]?.body)).not.toContain(
      'cache_control',
    );
  });
  it('supports recorded mode around this dialect', async () => {
    server = await startFakeAnthropicServer({ chunks: anthropicStream });
    const fs = await import('node:fs/promises');
    const os = await import('node:os');
    const path = await import('node:path');
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'anthropic-record-'));
    const fixturePath = path.join(dir, 'fixture.ndjson');
    try {
      const recorder = new RecordedLlmAdapter({
        mode: 'record',
        fixturePath,
        upstream: adapterFor(),
      });
      const first = [];
      for await (const chunk of recorder.complete(request)) first.push(chunk);
      const replay = new RecordedLlmAdapter({ mode: 'strict', fixturePath });
      const second = [];
      for await (const chunk of replay.complete(request)) second.push(chunk);
      expect(second).toEqual(first);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
  it.each([429, 529, 500, 503])(
    'normalizes HTTP %i and discards response body',
    async (status) => {
      server = await startFakeAnthropicServer({ status });
      await expect(async () => collect(adapterFor())).rejects.toMatchObject({
        code: 'endpoint-error',
        status,
      });
      try {
        await collect(adapterFor());
      } catch (error) {
        expect((error as Error).message).not.toContain(
          'private endpoint response',
        );
      }
    },
  );
  it('normalizes overloaded SSE errors without leaking provider text', async () => {
    server = await startFakeAnthropicServer({
      chunks: [
        'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"private details"}}\n\n',
      ],
    });
    await expect(async () => collect(adapterFor())).rejects.toMatchObject({
      code: 'endpoint-error',
      status: 529,
    });
  });
  it('normalizes timeout and explicit cancellation', async () => {
    server = await startFakeAnthropicServer({ delayMs: 150 });
    await expect(async () =>
      collect(adapterFor(false, 25)),
    ).rejects.toMatchObject({ code: 'endpoint-timeout' });
  });
  it('does not include the key in adapter errors or serialization', async () => {
    server = await startFakeAnthropicServer({ status: 500 });
    const adapter = adapterFor();
    try {
      await collect(adapter);
    } catch (error) {
      expect(JSON.stringify(error)).not.toContain('test-secret');
      expect((error as Error).message).not.toContain('test-secret');
    }
    expect(String(new Secret('test-secret'))).toBe('[REDACTED]');
    expect(LlmEndpointError).toBeDefined();
  });
  it('does not strip schema keywords for the Anthropic dialect', async () => {
    server = await startFakeAnthropicServer({ chunks: anthropicStream });
    const adapter = adapterFor();
    for await (const chunk of adapter.complete({
      ...request,
      tools: [
        {
          name: 'fixture',
          description: 'fixture',
          parameters: { type: 'string', pattern: '^ok$', maxLength: 5 },
        },
      ],
    }))
      void chunk;
    expect(
      (server.requests[0]?.body as { tools: { input_schema: unknown }[] })
        .tools[0]!.input_schema,
    ).toEqual({
      type: 'string',
      pattern: '^ok$',
      maxLength: 5,
    });
  });
});
