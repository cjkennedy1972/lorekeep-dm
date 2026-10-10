import { readFile } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { DMToolArgsSchema } from '@game/schema';
import { z } from 'zod';
import { buildPrompt } from '../../src/dm/prompt.js';
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

  const adapterFor = (
    timeoutMs = 500,
    unsupportedToolSchemaKeywords: readonly string[] = [],
  ) => {
    if (!server) throw new Error('fake endpoint not started');
    return new OpenAICompatibleAdapter({
      baseUrl: server.baseUrl,
      model: 'fixture-model',
      apiKey: new Secret('test-secret'),
      egress: createEgressGuard({
        allowLocalHosts: ['127.0.0.1', 'localhost'],
      }),
      timeoutMs,
      unsupportedToolSchemaKeywords,
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

  it('ignores reasoning deltas while assembling native tool calls from recorded SSE', async () => {
    const fixture = await readFile(
      new URL('./fixtures/reasoning-native.sse', import.meta.url),
      'utf8',
    );
    server = await startFakeOpenAIServer({ chunks: [fixture] });
    const chunks = await collect(adapterFor());
    expect(chunks.filter((chunk) => chunk.type === 'text')).toEqual([]);
    expect(chunks.find((chunk) => chunk.type === 'tool-call')).toEqual({
      type: 'tool-call',
      id: 'call_probe_1',
      name: 'probe_capability',
      arguments: { scenarioId: 'scenario-00', accepted: true },
    });
    expect(JSON.stringify(chunks)).not.toContain('Let me consider');
  });

  it('ignores reasoning deltas and keeps only narration-channel content for JSON-schema output', async () => {
    const fixture = await readFile(
      new URL('./fixtures/reasoning-json-schema.sse', import.meta.url),
      'utf8',
    );
    server = await startFakeOpenAIServer({ chunks: [fixture] });
    const chunks = [];
    for await (const chunk of adapterFor().complete({
      messages: [{ role: 'user', content: 'x' }],
      maxTokens: 2_048,
      toolMode: 'json-schema',
      responseSchema: { type: 'object' },
    }))
      chunks.push(chunk);
    expect(chunks.filter((chunk) => chunk.type === 'text')).toEqual([
      {
        type: 'text',
        delta: '{"scenarioId":"scenario-00","accepted":true}',
      },
    ]);
    expect(JSON.stringify(chunks)).not.toContain('I will format');
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

  it('strips configured keywords recursively on the wire without mutating canonical schemas or prompt hashes', async () => {
    server = await startFakeOpenAIServer({ chunks: textStream });
    const canonical = {
      type: 'object',
      properties: {
        pattern: { type: 'string', pattern: '^literal$', maxLength: 20 },
        value: { type: 'string', pattern: '^ok$', maxLength: 5 },
      },
      required: ['value'],
    };
    const original = structuredClone(canonical);
    const dmCanonicalSchema = z.toJSONSchema(DMToolArgsSchema.request_check);
    const dmCanonicalBefore = structuredClone(dmCanonicalSchema);
    const promptInput = {
      catalogVersion: 'fixture',
      toolMode: 'native' as const,
      sceneId: 'scene',
      settingsHash: 'settings',
      session: {
        contentTier: 'standard',
        safetySettings: {},
        partyRoster: [],
        premise: 'fixture',
        sceneSummary: '',
      },
      activeMode: 'exploration' as const,
      turn: { state: { characters: [] }, playerText: 'test' },
    };
    const prefixHashBefore = buildPrompt(promptInput).promptPrefixHash;
    const adapter = adapterFor(500, ['pattern', 'maxLength']);
    for await (const chunk of adapter.complete({
      messages: [{ role: 'user', content: 'x' }],
      maxTokens: 3,
      toolMode: 'native',
      tools: [
        { name: 'fixture', description: 'fixture', parameters: canonical },
      ],
    }))
      void chunk;
    const params = (
      server.requests[0]?.body as {
        tools: { function: { parameters: typeof canonical } }[];
      }
    ).tools[0]!.function.parameters;
    expect(params).toEqual({
      type: 'object',
      properties: { pattern: { type: 'string' }, value: { type: 'string' } },
      required: ['value'],
    });
    expect(canonical).toEqual(original);
    expect(dmCanonicalSchema).toEqual(dmCanonicalBefore);
    expect(JSON.stringify(dmCanonicalSchema)).toContain('pattern');
    expect(JSON.stringify(dmCanonicalSchema)).toContain('maxLength');
    expect(buildPrompt(promptInput).promptPrefixHash).toBe(prefixHashBefore);
    expect(
      DMToolArgsSchema.request_check.safeParse({
        actorId: 'not-an-entity-id',
        ability: 'dex',
        dc: 10,
        dcReason: 'A valid reason',
      }).success,
    ).toBe(false);
  });

  it('leaves schemas unchanged when endpoint keyword exclusions default empty', async () => {
    server = await startFakeOpenAIServer({ chunks: textStream });
    const schema = { type: 'string', pattern: '^ok$', maxLength: 5 };
    for await (const chunk of adapterFor().complete({
      messages: [{ role: 'user', content: 'x' }],
      maxTokens: 3,
      toolMode: 'native',
      tools: [{ name: 'fixture', description: 'fixture', parameters: schema }],
    }))
      void chunk;
    expect(
      (
        server.requests[0]?.body as {
          tools: { function: { parameters: unknown } }[];
        }
      ).tools[0]!.function.parameters,
    ).toEqual(schema);
  });
});
