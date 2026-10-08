import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type {
  LlmAdapter,
  LlmCapabilities,
  LlmChunk,
  LlmRequest,
} from './adapter.js';
import { LlmEndpointError } from './adapter.js';

export type FixtureMode = 'strict' | 'lenient' | 'record';
type Header = {
  v: 1;
  kind: 'header';
  suite: string;
  turn: string;
  toolMode: string;
  model: string;
  catalogVersion: string;
  promptPrefixHash: string;
  turnSeed: string;
  recordedAt: string;
  endpointProfile: string;
};
type Entry =
  | {
      kind: 'request';
      i: number;
      promptHash: string;
      dynamicHash: string;
      toolNames: string[];
    }
  | { kind: 'response'; i: number; chunks: LlmChunk[] };
export interface RecordedAdapterOptions {
  mode?: FixtureMode;
  fixturePath: string;
  upstream?: LlmAdapter;
  header?: Partial<Omit<Header, 'v' | 'kind' | 'recordedAt'>>;
  prefix?: string;
  dynamic?: (request: LlmRequest) => string;
  prompt?: (request: LlmRequest) => string;
  allowRecord?: boolean;
  environment?: string;
  warn?: (message: string) => void;
}
const sha = (value: string) =>
  `sha256:${createHash('sha256').update(value).digest('hex')}`;
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(',')}}`;
  return JSON.stringify(value);
};
const defaultPrompt = (request: LlmRequest) =>
  canonical({
    messages: request.messages,
    maxTokens: request.maxTokens,
    toolMode: request.toolMode,
    tools: request.tools,
    responseSchema: request.responseSchema,
  });
const redactChunk = (chunk: LlmChunk): LlmChunk =>
  chunk.type === 'text'
    ? {
        ...chunk,
        delta: chunk.delta.replace(/(bearer\s+)[^\s"']+/gi, '$1[REDACTED]'),
      }
    : chunk;
const line = (value: unknown) => `${JSON.stringify(value)}\n`;
const integrity = (content: string) => sha(content);

/** Hash-matched NDJSON recording wrapper. Tool results are asserted by the engine caller. */
export class RecordedLlmAdapter implements LlmAdapter {
  private readonly mode: FixtureMode;
  private index = 0;
  private entries?: Entry[];
  private header?: Header;
  private readonly prompt: (request: LlmRequest) => string;
  private readonly dynamic: (request: LlmRequest) => string;
  constructor(private readonly options: RecordedAdapterOptions) {
    this.mode = options.mode ?? 'strict';
    const env = options.environment ?? process.env.NODE_ENV ?? 'development';
    if (env === 'production' && this.mode !== 'strict')
      throw new Error(
        `LLM fixture mode '${this.mode}' is forbidden in production`,
      );
    if (
      this.mode === 'record' &&
      !options.allowRecord &&
      env !== 'test' &&
      env !== 'development'
    )
      throw new Error(
        'LLM fixture record mode requires explicit non-production opt-in',
      );
    if (this.mode === 'record' && !options.upstream)
      throw new Error('LLM fixture record mode requires an upstream adapter');
    this.prompt = options.prompt ?? defaultPrompt;
    this.dynamic = options.dynamic ?? this.prompt;
  }
  capabilities(): LlmCapabilities {
    return (
      this.options.upstream?.capabilities() ?? {
        streaming: true,
        nativeTools: true,
        jsonSchema: true,
      }
    );
  }
  async probe(signal?: AbortSignal): Promise<boolean> {
    return this.mode !== 'record' || this.options.upstream!.probe(signal);
  }
  async *complete(request: LlmRequest): AsyncIterable<LlmChunk> {
    if (request.signal?.aborted)
      throw new LlmEndpointError('stream-aborted', 'LLM request was aborted');
    const full = this.prompt(request),
      dynamic = this.dynamic(request),
      prefixHash = sha(this.options.prefix ?? '');
    if (this.mode === 'record') {
      await this.recordHeader(prefixHash);
      const chunks: LlmChunk[] = [];
      for await (const chunk of this.options.upstream!.complete(request)) {
        const safe = redactChunk(chunk);
        chunks.push(safe);
        yield safe;
      }
      await appendFile(
        this.options.fixturePath,
        line({
          kind: 'request',
          i: this.index,
          promptHash: sha(full),
          dynamicHash: sha(dynamic),
          toolNames: request.tools?.map((tool) => tool.name) ?? [],
        }),
        { mode: 0o600 },
      );
      await appendFile(
        this.options.fixturePath,
        line({ kind: 'response', i: this.index, chunks }),
      );
      const recorded = await readFile(this.options.fixturePath, 'utf8');
      await appendFile(
        this.options.fixturePath,
        line({ kind: 'integrity', sha256: integrity(recorded) }),
      );
      this.index += 1;
      return;
    }
    await this.load();
    if (prefixHash !== this.header!.promptPrefixHash)
      throw new Error(
        `fixture prefix-hash drift: expected ${this.header!.promptPrefixHash}, got ${prefixHash}`,
      );
    const expected = this.entries![this.index * 2],
      response = this.entries![this.index * 2 + 1];
    if (
      !expected ||
      !response ||
      expected.kind !== 'request' ||
      response.kind !== 'response'
    )
      throw new Error(
        `fixture exhausted or malformed at interaction ${this.index}`,
      );
    const actualHash = sha(dynamic);
    if (expected.dynamicHash !== actualHash) {
      const diff = `interaction=${this.index}\nexpected dynamicHash: ${expected.dynamicHash}\nactual dynamicHash:   ${actualHash}\nexpected promptHash: ${expected.promptHash}\nactual promptHash:   ${sha(full)}\nexpected toolNames: ${JSON.stringify(expected.toolNames)}\nactual toolNames:   ${JSON.stringify(request.tools?.map((tool) => tool.name) ?? [])}`;
      if (this.mode === 'strict')
        throw new Error(`fixture drift at i=${this.index}\n${diff}`);
      this.options.warn?.(`fixture drift at i=${this.index}\n${diff}`);
    }
    for (const chunk of response.chunks) {
      if (request.signal?.aborted)
        throw new LlmEndpointError('stream-aborted', 'LLM request was aborted');
      if (chunk.type !== 'text') {
        yield chunk;
        continue;
      }
      for (let offset = 0; offset < chunk.delta.length; offset += 24)
        yield { type: 'text', delta: chunk.delta.slice(offset, offset + 24) };
    }
    this.index += 1;
  }
  /** Assert recomputed tool output; recorded data is never returned to the caller. */
  assertToolResult(index: number, actual: unknown, recorded: unknown): void {
    const expected = canonical(recorded),
      got = canonical(actual);
    if (expected !== got)
      throw new Error(
        `recorded tool result mismatch at i=${index}\nexpected: ${expected}\nactual:   ${got}`,
      );
  }
  private async recordHeader(prefixHash: string): Promise<void> {
    if (this.header) return;
    const header: Header = {
      v: 1,
      kind: 'header',
      suite: this.options.header?.suite ?? 'recorded',
      turn: this.options.header?.turn ?? 'turn',
      toolMode: this.options.header?.toolMode ?? 'native',
      model: this.options.header?.model ?? 'recorded',
      catalogVersion: this.options.header?.catalogVersion ?? 'unknown',
      promptPrefixHash: prefixHash,
      turnSeed: this.options.header?.turnSeed ?? '0x0000000000000000',
      recordedAt: new Date().toISOString().slice(0, 10),
      endpointProfile: this.options.header?.endpointProfile ?? 'configured',
    };
    await mkdir(dirname(this.options.fixturePath), { recursive: true });
    await writeFile(this.options.fixturePath, line(header), { mode: 0o600 });
    this.header = header;
  }
  private async load(): Promise<void> {
    if (this.entries) return;
    const contents = await readFile(this.options.fixturePath, 'utf8');
    const lines = contents.split(/\r?\n/).filter(Boolean);
    let parsed: unknown[];
    try {
      parsed = contents
        .split(/\r?\n/)
        .filter(Boolean)
        .map((item) => JSON.parse(item) as unknown);
    } catch {
      throw new Error('recorded fixture is invalid NDJSON');
    }
    const footer = parsed.pop() as
      | { kind?: string; sha256?: string }
      | undefined;
    const content = lines
      .slice(0, -1)
      .map((item) => `${item}\n`)
      .join('');
    if (footer?.kind !== 'integrity' || footer.sha256 !== integrity(content))
      throw new Error(
        'recorded fixture integrity check failed: fixture bytes were modified',
      );
    const header = parsed[0] as Header | undefined;
    if (!header || header.v !== 1 || header.kind !== 'header')
      throw new Error('recorded fixture has no valid v1 header');
    const entries = parsed.slice(1) as Entry[];
    if (
      entries.some(
        (entry, i) =>
          !entry ||
          (entry.kind !== 'request' && entry.kind !== 'response') ||
          entry.i !== Math.floor(i / 2),
      )
    )
      throw new Error('recorded fixture interaction sequence is malformed');
    this.header = header;
    this.entries = entries;
  }
}
export const fixtureModeFromEnvironment = (
  env: NodeJS.ProcessEnv = process.env,
): FixtureMode => {
  const value = env.LLM_FIXTURE_MODE ?? 'strict';
  if (value !== 'strict' && value !== 'lenient' && value !== 'record')
    throw new Error(`invalid LLM_FIXTURE_MODE: ${value}`);
  if (env.NODE_ENV === 'production' && value !== 'strict')
    throw new Error(`LLM_FIXTURE_MODE=${value} is forbidden in production`);
  return value;
};
