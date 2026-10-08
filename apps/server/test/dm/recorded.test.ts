import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { OpenAICompatibleAdapter } from '../../src/llm/dialects/openai.js';
import { createEgressGuard } from '../../src/llm/egress.js';
import { Secret } from '../../src/llm/secret.js';
import {
  RecordedLlmAdapter,
  fixtureModeFromEnvironment,
} from '../../src/llm/recorded.js';
import {
  createTurnSeed,
  formatTurnSeed,
  rollSeed,
  xoshiro256ssState,
} from '../../src/dm/seed.js';
import {
  startFakeOpenAIServer,
  textStream,
  type FakeOpenAIServer,
} from '../llm/fakeOpenAIServer.js';

let server: FakeOpenAIServer | undefined;
let directory: string | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});
const collect = async (
  adapter: RecordedLlmAdapter,
  messages = 'fixture prompt',
) => {
  const chunks = [];
  for await (const chunk of adapter.complete({
    messages: [{ role: 'user', content: messages }],
    maxTokens: 12,
  }))
    chunks.push(chunk);
  return chunks;
};
const fakeAdapter = () => {
  if (!server) throw new Error('server not started');
  return new OpenAICompatibleAdapter({
    baseUrl: server.baseUrl,
    model: 'fixture-model',
    apiKey: new Secret('secret-key'),
    // the fake server listens on loopback: allowed only via the operator allowlist (M2-19)
    egress: createEgressGuard({ allowLocalHosts: ['127.0.0.1', 'localhost'] }),
  });
};

describe('recorded LLM adapter with the OpenAI adapter and in-process fake server', () => {
  it('records and replays identical streamed output; redacts auth and asserts tool results', async () => {
    server = await startFakeOpenAIServer({ chunks: textStream });
    directory = await mkdtemp(join(tmpdir(), 'lorekeep-recorded-'));
    const fixturePath = join(directory, 'session.ndjson');
    const request = {
      messages: [{ role: 'user' as const, content: 'fixture prompt' }],
      maxTokens: 12,
    };
    const recorder = new RecordedLlmAdapter({
      mode: 'record',
      fixturePath,
      upstream: fakeAdapter(),
      prefix: 'static blocks',
      dynamic: () => 'dynamic blocks',
    });
    const first = [];
    for await (const chunk of recorder.complete(request)) first.push(chunk);
    const fixture = await readFile(fixturePath, 'utf8');
    expect(fixture.split('\n')).toHaveLength(5);
    expect(fixture).not.toContain('secret-key');
    expect(server.requests[0]?.headers.authorization).toBe('Bearer ***');
    const replay = new RecordedLlmAdapter({
      mode: 'strict',
      fixturePath,
      prefix: 'static blocks',
      dynamic: () => 'dynamic blocks',
    });
    const second = [];
    for await (const chunk of replay.complete(request)) second.push(chunk);
    expect(second).toEqual(first);
    replay.assertToolResult(
      0,
      { ok: true, summary: 'resolved' },
      { summary: 'resolved', ok: true },
    );
    expect(() =>
      replay.assertToolResult(0, { ok: false }, { ok: true }),
    ).toThrow(/recorded tool result mismatch/);
  });
  it('fails loudly on byte tampering and on prefix drift in all modes', async () => {
    server = await startFakeOpenAIServer({ chunks: textStream });
    directory = await mkdtemp(join(tmpdir(), 'lorekeep-recorded-'));
    const fixturePath = join(directory, 'session.ndjson');
    const request = {
      messages: [{ role: 'user' as const, content: 'fixture prompt' }],
      maxTokens: 12,
    };
    const recorder = new RecordedLlmAdapter({
      mode: 'record',
      fixturePath,
      upstream: fakeAdapter(),
      prefix: 'prefix',
      dynamic: () => 'body',
    });
    for await (const chunk of recorder.complete(request)) void chunk;
    const original = await readFile(fixturePath, 'utf8');
    await writeFile(fixturePath, original.replace('hello ', 'jello '));
    const tampered = new RecordedLlmAdapter({
      mode: 'strict',
      fixturePath,
      prefix: 'prefix',
      dynamic: () => 'body',
    });
    await expect(collect(tampered)).rejects.toThrow(
      /invalid NDJSON|malformed|drift|fixture/,
    );
    await writeFile(fixturePath, original);
    for (const mode of ['strict', 'lenient'] as const) {
      const adapter = new RecordedLlmAdapter({
        mode,
        fixturePath,
        prefix: 'changed prefix',
        dynamic: () => 'body',
        ...(mode === 'record' ? { upstream: fakeAdapter() } : {}),
      });
      await expect(collect(adapter)).rejects.toThrow(/prefix-hash drift/);
    }
  });
  it('rejects replay and record modes in production configuration', () => {
    expect(() =>
      fixtureModeFromEnvironment({
        NODE_ENV: 'production',
        LLM_FIXTURE_MODE: 'record',
      }),
    ).toThrow(/forbidden/);
    expect(() =>
      fixtureModeFromEnvironment({
        NODE_ENV: 'production',
        LLM_FIXTURE_MODE: 'lenient',
      }),
    ).toThrow(/forbidden/);
  });
});

describe('turn seeds', () => {
  it('uses fixed seeds only in test mode and derives distinct per-roll substreams', () => {
    expect(
      formatTurnSeed(
        createTurnSeed({ testMode: true, fixedSeed: '0x4f2a91c7b3e05d18' }),
      ),
    ).toBe('0x4f2a91c7b3e05d18');
    expect(() => createTurnSeed({ fixedSeed: 4 })).toThrow(/test mode/);
    expect(rollSeed(10n, 0)).not.toBe(rollSeed(10n, 1));
    expect(xoshiro256ssState(rollSeed(10n, 0))).toEqual(
      xoshiro256ssState(rollSeed(10n, 0)),
    );
    expect(createTurnSeed()).not.toBe(createTurnSeed());
  });
});
