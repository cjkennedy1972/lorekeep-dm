import { afterEach, describe, expect, it } from 'vitest';
import { LlmEndpointError } from '../../src/llm/adapter.js';
import { createEgressGuard } from '../../src/llm/egress.js';
import { Secret } from '../../src/llm/secret.js';
import { OpenAICompatibleAdapter } from '../../src/llm/dialects/openai.js';
import {
  startFakeOpenAIServer,
  textStream,
  type FakeOpenAIServer,
} from './fakeOpenAIServer.js';

describe('OpenAI-compatible LLM adapter', () => {
  let server: FakeOpenAIServer | undefined;
  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  const adapterFor = (timeoutMs = 500) => {
    if (!server) throw new Error('fake endpoint not started');
    return new OpenAICompatibleAdapter({
      baseUrl: server.baseUrl,
      model: 'fixture-model',
      apiKey: new Secret('test-secret'),
      egress: createEgressGuard({
        allowLocalHosts: ['127.0.0.1', 'localhost'],
      }),
      timeoutMs,
    });
  };
  const collect = async (adapter: OpenAICompatibleAdapter) => {
    const chunks = [];
    for await (const chunk of adapter.complete({
      messages: [{ role: 'user', content: 'private prompt' }],
      maxTokens: 10,
    }))
      chunks.push(chunk);
    return chunks;
  };

  it('streams text and provider usage from an in-process endpoint', async () => {
    server = await startFakeOpenAIServer({ chunks: textStream });
    const chunks = await collect(adapterFor());
    expect(chunks.filter((chunk) => chunk.type === 'text')).toEqual([
      { type: 'text', delta: 'hello ' },
      { type: 'text', delta: 'world' },
    ]);
    expect(chunks.at(-1)).toEqual({
      type: 'usage',
      usage: { input: 10, output: 2, cacheRead: 3, estimate: false },
    });
    expect(server.requests[0]?.headers.authorization).toBe('Bearer ***');
    expect(JSON.stringify(server.requests[0])).not.toContain('private prompt');
  });

  it('assembles streamed tool-call arguments split across chunks', async () => {
    server = await startFakeOpenAIServer({
      chunks: [
        String.raw`data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"request_check","arguments":"{\"dc\":"}}]}}]}

`,
        String.raw`data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"15,\"ability\":\"dex\"}"}}]}}]}

`,
        'data: [DONE]\n\n',
      ],
    });
    const chunks = await collect(adapterFor());
    expect(chunks.find((chunk) => chunk.type === 'tool-call')).toEqual({
      type: 'tool-call',
      id: 'call_1',
      name: 'request_check',
      arguments: { dc: 15, ability: 'dex' },
    });
    expect(chunks.at(-1)).toMatchObject({
      type: 'usage',
      usage: { estimate: true },
    });
  });

  it('rejects a malformed SSE payload without exposing payload contents', async () => {
    server = await startFakeOpenAIServer({
      chunks: ['data: {"secret prompt":"private"}\n\n'],
    });
    await expect(async () => collect(adapterFor())).rejects.toMatchObject({
      code: 'endpoint-error',
    });
  });

  it('normalizes request timeout', async () => {
    server = await startFakeOpenAIServer({ delayMs: 150 });
    await expect(async () => collect(adapterFor(30))).rejects.toMatchObject({
      code: 'endpoint-timeout',
    });
  });

  it('normalizes explicit cancellation', async () => {
    server = await startFakeOpenAIServer({ delayMs: 200 });
    const controller = new AbortController();
    const adapter = adapterFor();
    const pending = (async () => {
      for await (const chunk of adapter.complete({
        messages: [{ role: 'user', content: 'x' }],
        maxTokens: 1,
        signal: controller.signal,
      })) {
        void chunk;
      }
    })();
    setTimeout(() => controller.abort(), 20);
    await expect(pending).rejects.toMatchObject({ code: 'stream-aborted' });
  });

  it.each([429, 503])(
    'normalizes HTTP %i without retaining endpoint body',
    async (status) => {
      server = await startFakeOpenAIServer({ status });
      try {
        await collect(adapterFor());
        throw new Error('expected endpoint error');
      } catch (error) {
        expect(error).toBeInstanceOf(LlmEndpointError);
        expect(error).toMatchObject({ code: 'endpoint-error', status });
        expect((error as Error).message).not.toContain(
          'private endpoint response',
        );
      }
    },
  );

  it('maps tool and JSON-schema modes to their respective request shapes', async () => {
    server = await startFakeOpenAIServer({ chunks: textStream });
    const adapter = adapterFor();
    for await (const chunk of adapter.complete({
      messages: [{ role: 'user', content: 'x' }],
      maxTokens: 3,
      toolMode: 'native',
      tools: [
        {
          name: 'request_check',
          description: 'check',
          parameters: { type: 'object' },
        },
      ],
    })) {
      void chunk;
    }
    for await (const chunk of adapter.complete({
      messages: [{ role: 'user', content: 'x' }],
      maxTokens: 3,
      toolMode: 'json-schema',
      responseSchema: { type: 'object' },
    })) {
      void chunk;
    }
    expect(server.requests[0]?.body).toMatchObject({
      tools: [{ type: 'function', function: { name: 'request_check' } }],
    });
    expect(server.requests[1]?.body).toMatchObject({
      response_format: { type: 'json_schema', json_schema: { strict: true } },
    });
  });
});
