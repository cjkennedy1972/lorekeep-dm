/** Provider-neutral LLM adapter contracts and endpoint failure taxonomy. */
export type ToolMode = 'native' | 'json-schema';
export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';
export interface LlmMessage {
  role: MessageRole;
  content: string;
  name?: string;
  toolCallId?: string;
  toolCalls?: { id: string; name: string; arguments: unknown }[];
}
export interface LlmTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}
export interface LlmRequest {
  messages: LlmMessage[];
  maxTokens: number;
  toolMode?: ToolMode;
  tools?: LlmTool[];
  responseSchema?: Record<string, unknown>;
  signal?: AbortSignal;
  /** Stable prefix boundary, used for provider prompt caching when profile.cache is enabled. */
  cacheHints?: { stablePrefixMessages: number };
}
export interface LlmCapabilities {
  streaming: boolean;
  nativeTools: boolean;
  jsonSchema: boolean;
}
export interface TokenUsage {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
  estimate: boolean;
}
export type LlmChunk =
  | { type: 'text'; delta: string }
  | { type: 'tool-call'; id: string; name: string; arguments: unknown }
  | { type: 'usage'; usage: TokenUsage };
export type LlmErrorCode =
  | 'endpoint-timeout'
  | 'endpoint-error'
  | 'stream-aborted';
export class LlmEndpointError extends Error {
  constructor(
    readonly code: LlmErrorCode,
    message: string,
    readonly status?: number,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'LlmEndpointError';
  }
}
export interface LlmAdapter {
  capabilities(): LlmCapabilities;
  complete(request: LlmRequest): AsyncIterable<LlmChunk>;
  probe(signal?: AbortSignal): Promise<boolean>;
}

/** Normalize unknown failures without including request/response content. */
export function normalizeEndpointError(error: unknown): LlmEndpointError {
  if (error instanceof LlmEndpointError) return error;
  if (error instanceof Error && error.name === 'AbortError') {
    return new LlmEndpointError('stream-aborted', 'LLM request was aborted');
  }
  return new LlmEndpointError('endpoint-error', 'LLM endpoint request failed');
}
