import type { LlmAdapter, LlmChunk, LlmTool, ToolMode } from './adapter.js';

export type ProbeCapability =
  | 'reachability'
  | 'streaming'
  | 'nativeTools'
  | 'jsonSchema'
  | 'contextWindow32k';

export interface CapabilityResult {
  supported: boolean;
  detail?: string;
}

export interface EndpointProfile {
  id: string;
  model: string;
  toolMode: ToolMode | 'unsupported';
  capabilities: Record<ProbeCapability, CapabilityResult>;
  validCallRate: number;
  schemaViolations: number;
  ttftMs: number | null;
  contextWindow: number | null;
  qualified: false;
  probedAt: string;
}

export interface ProbeOptions {
  id: string;
  model: string;
  contextWindow?: number;
  scenarios?: number;
  now?: () => number;
  signal?: AbortSignal;
  persist?: (profile: EndpointProfile) => Promise<void> | void;
}

const tool: LlmTool = {
  name: 'probe_capability',
  description:
    'Return the supplied synthetic probe scenario identifier and accepted=true.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      scenarioId: { type: 'string' },
      accepted: { type: 'boolean', const: true },
    },
    required: ['scenarioId', 'accepted'],
  },
};

const responseSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    scenarioId: { type: 'string' },
    accepted: { type: 'boolean', const: true },
  },
  required: ['scenarioId', 'accepted'],
};

const fact = (supported: boolean, detail?: string): CapabilityResult => ({
  supported,
  ...(detail ? { detail } : {}),
});

interface ProbeResponse {
  chunks: LlmChunk[];
  ttftMs: number | null;
  streamed: boolean;
}

async function run(
  adapter: LlmAdapter,
  request: Parameters<LlmAdapter['complete']>[0],
  now: () => number,
): Promise<ProbeResponse> {
  const start = now();
  const chunks: LlmChunk[] = [];
  let ttftMs: number | null = null;
  for await (const chunk of adapter.complete(request)) {
    chunks.push(chunk);
    if (
      ttftMs === null &&
      (chunk.type === 'text' || chunk.type === 'tool-call')
    ) {
      ttftMs = Math.max(0, now() - start);
    }
  }
  return { chunks, ttftMs, streamed: chunks.length > 0 };
}

function isValid(chunks: LlmChunk[], id: string, mode: ToolMode): boolean {
  let value: unknown;
  if (mode === 'native') {
    const calls = chunks.filter((chunk) => chunk.type === 'tool-call');
    if (
      calls.length !== 1 ||
      calls[0]?.type !== 'tool-call' ||
      calls[0].name !== tool.name
    ) {
      return false;
    }
    value = calls[0].arguments;
  } else {
    const text = chunks
      .filter((chunk) => chunk.type === 'text')
      .map((chunk) => chunk.delta)
      .join('');
    try {
      value = JSON.parse(text) as unknown;
    } catch {
      return false;
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    record.scenarioId === id &&
    record.accepted === true &&
    Object.keys(record).length === 2
  );
}

interface ModeResult {
  valid: number;
  violations: number;
  validRate: number;
  ttftMs: number | null;
  reachable: boolean;
  streaming: boolean;
}

async function testMode(
  adapter: LlmAdapter,
  mode: ToolMode,
  count: number,
  now: () => number,
  signal?: AbortSignal,
): Promise<ModeResult> {
  let valid = 0;
  let violations = 0;
  let ttftMs: number | null = null;
  let reachable = false;
  let streaming = false;
  for (let i = 0; i < count; i++) {
    signal?.throwIfAborted();
    const id = `scenario-${i.toString().padStart(2, '0')}`;
    try {
      const result = await run(
        adapter,
        {
          messages: [
            {
              role: 'system',
              content:
                'Synthetic capability probe. Return only the requested synthetic result.',
            },
            {
              role: 'user',
              content: `Return scenarioId ${id} and accepted=true using the requested response mechanism.`,
            },
          ],
          maxTokens: 32,
          toolMode: mode,
          signal,
          ...(mode === 'native'
            ? {
                tools: [
                  {
                    ...tool,
                    parameters: {
                      ...tool.parameters,
                      properties: {
                        scenarioId: { type: 'string', const: id },
                        accepted: { type: 'boolean', const: true },
                      },
                    },
                  },
                ],
              }
            : { responseSchema }),
        },
        now,
      );
      reachable = true;
      streaming ||= result.streamed;
      ttftMs ??= result.ttftMs;
      if (isValid(result.chunks, id, mode)) valid++;
      else violations++;
    } catch {
      signal?.throwIfAborted();
      // Transport/provider failures are not schema violations and never retained.
    }
  }
  return {
    valid,
    violations,
    validRate: valid / count,
    ttftMs,
    reachable,
    streaming,
  };
}

/** Synthetic fixed battery; retains capability facts only, never request or response content. */
export async function probeEndpoint(
  adapter: LlmAdapter,
  options: ProbeOptions,
): Promise<EndpointProfile> {
  const now = options.now ?? Date.now;
  const count = Math.max(1, Math.min(20, Math.floor(options.scenarios ?? 20)));
  const native = await testMode(adapter, 'native', count, now, options.signal);
  const structured = await testMode(
    adapter,
    'json-schema',
    count,
    now,
    options.signal,
  );
  const nativeOk = native.validRate >= 0.95;
  const schemaOk = structured.validRate >= 0.95;
  const contextWindow = options.contextWindow ?? null;
  const capabilities: EndpointProfile['capabilities'] = {
    reachability: fact(native.reachable || structured.reachable),
    streaming: fact(
      native.streaming || structured.streaming,
      'no response chunks received',
    ),
    nativeTools: fact(
      nativeOk,
      nativeOk ? undefined : 'valid-call rate below 0.95',
    ),
    jsonSchema: fact(
      schemaOk,
      schemaOk ? undefined : 'valid-call rate below 0.95',
    ),
    contextWindow32k: fact(
      contextWindow !== null && contextWindow >= 32_000,
      contextWindow === null
        ? 'context window not configured'
        : `${contextWindow} tokens`,
    ),
  };
  const attempts =
    native.valid + native.violations + structured.valid + structured.violations;
  const profile: EndpointProfile = {
    id: options.id,
    model: options.model,
    toolMode: nativeOk ? 'native' : schemaOk ? 'json-schema' : 'unsupported',
    capabilities,
    validCallRate: attempts ? (native.valid + structured.valid) / attempts : 0,
    schemaViolations: native.violations + structured.violations,
    ttftMs: native.ttftMs ?? structured.ttftMs,
    contextWindow,
    qualified: false,
    probedAt: new Date(now()).toISOString(),
  };
  await options.persist?.(profile);
  return profile;
}
