import {
  LlmEndpointError,
  type LlmAdapter,
  type LlmCapabilities,
  type LlmChunk,
  type LlmRequest,
  normalizeEndpointError,
} from '../adapter.js';
import type { EgressGuard } from '../egress.js';
import type { Secret } from '../secret.js';

export interface AnthropicMessagesConfig {
  baseUrl: string;
  model: string;
  apiKey?: Secret;
  timeoutMs?: number;
  /** Prompt-cache markers are opt-in per endpoint profile. */
  cache?: boolean;
  /** The only outbound HTTP path; enforces the SSRF policy (M2-19). */
  egress: EgressGuard;
}
type JsonObject = Record<string, unknown>;
const isObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const endpointUrl = (baseUrl: string) =>
  `${baseUrl.replace(/\/+$/, '')}/messages`;

/** Translator for the Messages wire protocol; shared orchestration stays provider-neutral. */
export class AnthropicMessagesAdapter implements LlmAdapter {
  private readonly timeoutMs: number;

  constructor(private readonly config: AnthropicMessagesConfig) {
    this.timeoutMs = config.timeoutMs ?? 12_000;
  }

  capabilities(): LlmCapabilities {
    return { streaming: true, nativeTools: true, jsonSchema: false };
  }

  async probe(signal?: AbortSignal): Promise<boolean> {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    try {
      const response = await this.config.egress.fetch(
        endpointUrl(this.config.baseUrl),
        {
          method: 'POST',
          headers: this.headers(),
          body: JSON.stringify({
            model: this.config.model,
            max_tokens: 1,
            messages: [{ role: 'user', content: 'ping' }],
          }),
          signal: controller.signal,
        },
      );
      await response.body?.cancel().catch(() => undefined);
      return response.ok;
    } catch (error) {
      if (timedOut)
        throw new LlmEndpointError(
          'endpoint-timeout',
          'LLM endpoint request timed out',
        );
      if (signal?.aborted)
        throw new LlmEndpointError('stream-aborted', 'LLM request was aborted');
      throw normalizeEndpointError(error);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  }

  async *complete(request: LlmRequest): AsyncIterable<LlmChunk> {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);
    const abort = () => controller.abort();
    request.signal?.addEventListener('abort', abort, { once: true });
    try {
      const response = await this.config.egress.fetch(
        endpointUrl(this.config.baseUrl),
        {
          method: 'POST',
          headers: this.headers(),
          body: JSON.stringify(this.requestBody(request)),
          signal: controller.signal,
        },
      );
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new LlmEndpointError(
          'endpoint-error',
          `LLM endpoint returned HTTP ${response.status}`,
          response.status,
        );
      }
      if (!response.body)
        throw new LlmEndpointError(
          'endpoint-error',
          'LLM endpoint returned no response stream',
        );
      yield* this.readStream(response.body, request.signal, () => timedOut);
    } catch (error) {
      if (error instanceof LlmEndpointError) throw error;
      if (timedOut)
        throw new LlmEndpointError(
          'endpoint-timeout',
          'LLM endpoint request timed out',
        );
      if (request.signal?.aborted)
        throw new LlmEndpointError('stream-aborted', 'LLM request was aborted');
      throw normalizeEndpointError(error);
    } finally {
      clearTimeout(timer);
      request.signal?.removeEventListener('abort', abort);
      controller.abort();
    }
  }

  private requestBody(request: LlmRequest): JsonObject {
    const systemMessages = request.messages.filter((m) => m.role === 'system');
    const messages: JsonObject[] = [];
    for (const m of request.messages.filter((m) => m.role !== 'system')) {
      if (m.role === 'tool') {
        const result = {
          type: 'tool_result',
          tool_use_id: m.toolCallId ?? '',
          content: m.content,
        };
        const previous = messages.at(-1);
        if (previous?.role === 'user' && Array.isArray(previous.content))
          previous.content.push(result);
        else messages.push({ role: 'user', content: [result] });
      } else if (m.role === 'assistant' && m.toolCalls?.length) {
        messages.push({
          role: 'assistant',
          content: [
            ...(m.content ? [{ type: 'text', text: m.content }] : []),
            ...m.toolCalls.map((call) => ({
              type: 'tool_use',
              id: call.id,
              name: call.name,
              input: call.arguments,
            })),
          ],
        });
      } else
        messages.push({
          role: m.role === 'assistant' ? 'assistant' : 'user',
          content: m.content,
        });
    }
    const body: JsonObject = {
      model: this.config.model,
      max_tokens: request.maxTokens,
      stream: true,
      messages,
    };
    if (request.temperature !== undefined)
      body.temperature = request.temperature;
    if (systemMessages.length) {
      const stableCount = request.cacheHints?.stablePrefixMessages ?? 0;
      body.system = systemMessages.map((m, i) => ({
        type: 'text',
        text: m.content,
        ...(this.config.cache && i < stableCount
          ? { cache_control: { type: 'ephemeral' } }
          : {}),
      }));
    }
    if (request.toolMode === 'native' && request.tools?.length) {
      body.tools = request.tools.map((tool, i) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.parameters,
        ...(this.config.cache && i === request.tools!.length - 1
          ? { cache_control: { type: 'ephemeral' } }
          : {}),
      }));
    }
    // This protocol does not advertise JSON-schema response-format support.
    return body;
  }

  private headers(): HeadersInit {
    return {
      'content-type': 'application/json',
      'anthropic-version': '2023-06-01',
      ...(this.config.apiKey
        ? { 'x-api-key': this.config.apiKey.reveal() }
        : {}),
    };
  }

  private async *readStream(
    stream: ReadableStream<Uint8Array>,
    signal: AbortSignal | undefined,
    timedOut: () => boolean,
  ): AsyncGenerator<LlmChunk> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const tools = new Map<
      number,
      { id: string; name: string; input: string }
    >();
    let usage: LlmChunk | undefined;
    try {
      while (true) {
        if (signal?.aborted)
          throw new LlmEndpointError(
            'stream-aborted',
            'LLM request was aborted',
          );
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let boundary: number;
        while ((boundary = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          let event = '';
          let data = '';
          for (const line of frame.split(/\r?\n/)) {
            if (line.startsWith('event:')) event = line.slice(6).trim();
            else if (line.startsWith('data:')) data += line.slice(5).trim();
          }
          if (!data) continue;
          let parsed: unknown;
          try {
            parsed = JSON.parse(data);
          } catch {
            throw new LlmEndpointError(
              'endpoint-error',
              'Malformed streaming chunk',
            );
          }
          if (!isObject(parsed))
            throw new LlmEndpointError(
              'endpoint-error',
              'Malformed streaming chunk',
            );
          if (event === 'error' || parsed.type === 'error') {
            const errorType =
              isObject(parsed.error) && typeof parsed.error.type === 'string'
                ? parsed.error.type
                : '';
            if (errorType === 'overloaded_error')
              throw new LlmEndpointError(
                'endpoint-error',
                'LLM endpoint is overloaded',
                529,
              );
            throw new LlmEndpointError(
              'endpoint-error',
              'LLM endpoint stream failed',
            );
          }
          if (
            event === 'content_block_start' ||
            parsed.type === 'content_block_start'
          ) {
            if (
              typeof parsed.index !== 'number' ||
              !isObject(parsed.content_block)
            )
              throw new LlmEndpointError(
                'endpoint-error',
                'Malformed streaming chunk',
              );
            const block = parsed.content_block;
            if (
              block.type === 'tool_use' &&
              typeof block.id === 'string' &&
              typeof block.name === 'string'
            )
              tools.set(parsed.index, {
                id: block.id,
                name: block.name,
                input: '',
              });
            else if (
              block.type === 'text' &&
              typeof block.text === 'string' &&
              block.text
            )
              yield { type: 'text', delta: block.text };
          } else if (
            event === 'content_block_delta' ||
            parsed.type === 'content_block_delta'
          ) {
            if (typeof parsed.index !== 'number' || !isObject(parsed.delta))
              throw new LlmEndpointError(
                'endpoint-error',
                'Malformed streaming chunk',
              );
            if (
              parsed.delta.type === 'text_delta' &&
              typeof parsed.delta.text === 'string'
            )
              yield { type: 'text', delta: parsed.delta.text };
            else if (
              parsed.delta.type === 'input_json_delta' &&
              typeof parsed.delta.partial_json === 'string'
            ) {
              const tool = tools.get(parsed.index);
              if (!tool)
                throw new LlmEndpointError(
                  'endpoint-error',
                  'Malformed streaming chunk',
                );
              tool.input += parsed.delta.partial_json;
            }
          } else if (
            event === 'message_start' ||
            parsed.type === 'message_start'
          ) {
            if (!isObject(parsed.message) || !isObject(parsed.message.usage))
              throw new LlmEndpointError(
                'endpoint-error',
                'Malformed streaming chunk',
              );
            usage = this.usage(parsed.message.usage, true);
          } else if (
            event === 'message_delta' ||
            parsed.type === 'message_delta'
          ) {
            if (isObject(parsed.usage)) {
              const deltaUsage = this.usage(parsed.usage);
              const prior = usage?.type === 'usage' ? usage.usage : undefined;
              if (deltaUsage.type === 'usage') {
                usage = {
                  type: 'usage',
                  usage: {
                    ...deltaUsage.usage,
                    input: prior?.input ?? deltaUsage.usage.input,
                    ...(prior?.cacheRead === undefined
                      ? {}
                      : { cacheRead: prior.cacheRead }),
                    ...(prior?.cacheWrite === undefined
                      ? {}
                      : { cacheWrite: prior.cacheWrite }),
                    estimate: prior?.estimate ?? deltaUsage.usage.estimate,
                  },
                };
              }
            }
          }
        }
      }
      if (buffer.trim())
        throw new LlmEndpointError(
          'endpoint-error',
          'Malformed streaming chunk',
        );
      for (const tool of tools.values()) {
        let args: unknown;
        try {
          args = JSON.parse(tool.input);
        } catch {
          throw new LlmEndpointError(
            'endpoint-error',
            'Malformed streamed tool-call arguments',
          );
        }
        yield {
          type: 'tool-call',
          id: tool.id,
          name: tool.name,
          arguments: args,
        };
      }
      if (usage) yield usage;
      else
        yield { type: 'usage', usage: { input: 0, output: 0, estimate: true } };
    } catch (error) {
      if (error instanceof LlmEndpointError) throw error;
      if (timedOut())
        throw new LlmEndpointError(
          'endpoint-timeout',
          'LLM endpoint request timed out',
        );
      if (signal?.aborted)
        throw new LlmEndpointError('stream-aborted', 'LLM request was aborted');
      throw normalizeEndpointError(error);
    } finally {
      reader.releaseLock();
    }
  }

  private usage(value: JsonObject, requireInput = false): LlmChunk {
    const input = value.input_tokens;
    const output = value.output_tokens;
    if (requireInput && typeof input !== 'number')
      throw new LlmEndpointError('endpoint-error', 'Malformed usage metadata');
    const cacheRead = value.cache_read_input_tokens;
    const cacheWrite = value.cache_creation_input_tokens;
    return {
      type: 'usage',
      usage: {
        input: typeof input === 'number' ? input : 0,
        output: typeof output === 'number' ? output : 0,
        ...(typeof cacheRead === 'number' ? { cacheRead } : {}),
        ...(typeof cacheWrite === 'number' ? { cacheWrite } : {}),
        estimate: typeof output !== 'number',
      },
    };
  }
}
