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

export interface OpenAICompatibleConfig {
  baseUrl: string;
  model: string;
  apiKey?: Secret;
  timeoutMs?: number;
  /** The only outbound HTTP path; enforces the SSRF policy (M2-19). */
  egress: EgressGuard;
  unsupportedToolSchemaKeywords?: readonly string[];
}

type JsonObject = Record<string, unknown>;
const isObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const endpointUrl = (baseUrl: string) =>
  `${baseUrl.replace(/\/+$/, '')}/chat/completions`;

const SCHEMA_KEYWORDS = new Set([
  '$schema',
  '$id',
  '$ref',
  '$defs',
  'definitions',
  'type',
  'title',
  'description',
  'default',
  'examples',
  'enum',
  'const',
  'allOf',
  'anyOf',
  'oneOf',
  'not',
  'if',
  'then',
  'else',
  'required',
  'properties',
  'patternProperties',
  'additionalProperties',
  'propertyNames',
  'items',
  'prefixItems',
  'contains',
  'minItems',
  'maxItems',
  'uniqueItems',
  'minProperties',
  'maxProperties',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minLength',
  'maxLength',
  'pattern',
  'format',
  'contentEncoding',
  'contentMediaType',
]);

function stripUnsupportedSchemaKeywords(
  value: unknown,
  unsupported: readonly string[],
  inSchema = true,
): unknown {
  if (Array.isArray(value))
    return value.map((item) =>
      stripUnsupportedSchemaKeywords(item, unsupported, inSchema),
    );
  if (!isObject(value)) return value;
  const result: JsonObject = {};
  for (const [key, child] of Object.entries(value)) {
    if (inSchema && SCHEMA_KEYWORDS.has(key) && unsupported.includes(key))
      continue;
    // Property names are user data, not schema keywords. Their values are schemas.
    if (key === 'properties' || key === 'patternProperties') {
      if (isObject(child)) {
        result[key] = Object.fromEntries(
          Object.entries(child).map(([name, schema]) => [
            name,
            stripUnsupportedSchemaKeywords(schema, unsupported, true),
          ]),
        );
      } else result[key] = child;
    } else if (
      key === 'propertyNames' ||
      key === 'items' ||
      key === 'additionalProperties' ||
      key === 'contains' ||
      key === 'not' ||
      key === 'if' ||
      key === 'then' ||
      key === 'else' ||
      key === '$defs' ||
      key === 'definitions' ||
      key === 'allOf' ||
      key === 'anyOf' ||
      key === 'oneOf' ||
      key === 'prefixItems'
    ) {
      result[key] = stripUnsupportedSchemaKeywords(child, unsupported, true);
    } else {
      result[key] = child;
    }
  }
  return result;
}

/** OpenAI-compatible chat-completions wire dialect; config owns URL and model. */
export class OpenAICompatibleAdapter implements LlmAdapter {
  private readonly timeoutMs: number;

  constructor(private readonly config: OpenAICompatibleConfig) {
    this.timeoutMs = config.timeoutMs ?? 12_000;
  }

  capabilities(): LlmCapabilities {
    return { streaming: true, nativeTools: true, jsonSchema: true };
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
            messages: [{ role: 'user', content: 'ping' }],
            max_tokens: 1,
          }),
          signal: controller.signal,
        },
      );
      return response.ok;
    } catch (error) {
      if (timedOut)
        throw new LlmEndpointError(
          'endpoint-timeout',
          'LLM endpoint request timed out',
        );
      throw this.classify(error);
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
      const body = this.requestBody(request);
      const response = await this.config.egress.fetch(
        endpointUrl(this.config.baseUrl),
        {
          method: 'POST',
          headers: this.headers(),
          body: JSON.stringify(body),
          signal: controller.signal,
        },
      );
      if (!response.ok) {
        // Read but deliberately discard endpoint error bodies; they may echo prompts or secrets.
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
      throw this.classify(error);
    } finally {
      clearTimeout(timer);
      request.signal?.removeEventListener('abort', abort);
      controller.abort();
    }
  }

  private requestBody(request: LlmRequest): JsonObject {
    const body: JsonObject = {
      model: this.config.model,
      messages: request.messages.map((message) => ({
        role: message.role,
        content: message.content,
        ...(message.name ? { name: message.name } : {}),
        ...(message.toolCallId ? { tool_call_id: message.toolCallId } : {}),
        ...(message.toolCalls?.length
          ? {
              tool_calls: message.toolCalls.map((call) => ({
                id: call.id,
                type: 'function',
                function: {
                  name: call.name,
                  arguments: JSON.stringify(call.arguments),
                },
              })),
            }
          : {}),
      })),
      max_tokens: request.maxTokens,
      stream: true,
      stream_options: { include_usage: true },
    };
    if (request.toolMode === 'native' && request.tools?.length) {
      body.tools = request.tools.map((tool) => ({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: stripUnsupportedSchemaKeywords(
            tool.parameters,
            this.config.unsupportedToolSchemaKeywords ?? [],
          ),
        },
      }));
      body.tool_choice = 'auto';
    }
    if (request.toolMode === 'json-schema' && request.responseSchema) {
      body.response_format = {
        type: 'json_schema',
        json_schema: {
          name: 'dm_response',
          strict: true,
          schema: request.responseSchema,
        },
      };
    }
    return body;
  }

  private headers(): HeadersInit {
    return {
      'content-type': 'application/json',
      ...(this.config.apiKey
        ? { authorization: `Bearer ${this.config.apiKey.reveal()}` }
        : {}),
    };
  }

  private classify(error: unknown): LlmEndpointError {
    if (error instanceof Error && error.name === 'AbortError') {
      return new LlmEndpointError(
        'endpoint-timeout',
        'LLM endpoint request timed out',
      );
    }
    return normalizeEndpointError(error);
  }

  private async *readStream(
    stream: ReadableStream<Uint8Array>,
    signal: AbortSignal | undefined,
    timedOut: () => boolean,
  ): AsyncGenerator<LlmChunk> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const calls = new Map<
      number,
      { id?: string; name: string; arguments: string }
    >();
    let gotUsage = false;
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
        while ((boundary = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, boundary).trimEnd();
          buffer = buffer.slice(boundary + 1);
          if (!line || line.startsWith(':')) continue;
          if (!line.startsWith('data:'))
            throw new LlmEndpointError(
              'endpoint-error',
              'Malformed streaming chunk',
            );
          const data = line.slice(5).trim();
          if (data === '[DONE]') continue;
          let parsed: unknown;
          try {
            parsed = JSON.parse(data);
          } catch {
            throw new LlmEndpointError(
              'endpoint-error',
              'Malformed streaming chunk',
            );
          }
          if (!isObject(parsed) || !Array.isArray(parsed.choices)) {
            if (isObject(parsed) && isObject(parsed.usage)) {
              const usage = this.parseUsage(parsed.usage);
              if (usage) {
                gotUsage = true;
                yield { type: 'usage', usage };
              }
              continue;
            }
            throw new LlmEndpointError(
              'endpoint-error',
              'Malformed streaming chunk',
            );
          }
          const usage = isObject(parsed.usage)
            ? this.parseUsage(parsed.usage)
            : undefined;
          if (usage) {
            gotUsage = true;
            yield { type: 'usage', usage };
          }
          for (const choice of parsed.choices) {
            if (!isObject(choice) || !isObject(choice.delta)) {
              throw new LlmEndpointError(
                'endpoint-error',
                'Malformed streaming chunk',
              );
            }
            const delta = choice.delta;
            // Only the provider's content channel is player-facing narration.
            // Ignore reasoning fields (and null content) entirely.
            if (typeof delta.content === 'string' && delta.content.length) {
              yield { type: 'text', delta: delta.content };
            }
            if (delta.tool_calls !== undefined) {
              if (!Array.isArray(delta.tool_calls))
                throw new LlmEndpointError(
                  'endpoint-error',
                  'Malformed streaming chunk',
                );
              for (const item of delta.tool_calls) {
                if (
                  !isObject(item) ||
                  typeof item.index !== 'number' ||
                  !Number.isInteger(item.index)
                ) {
                  throw new LlmEndpointError(
                    'endpoint-error',
                    'Malformed streaming chunk',
                  );
                }
                const fn = isObject(item.function) ? item.function : {};
                const call = calls.get(item.index) ?? {
                  name: '',
                  arguments: '',
                };
                if (typeof item.id === 'string')
                  call.id = `${call.id ?? ''}${item.id}`;
                if (typeof fn.name === 'string') call.name += fn.name;
                if (typeof fn.arguments === 'string')
                  call.arguments += fn.arguments;
                calls.set(item.index, call);
              }
            }
          }
        }
      }
      buffer += decoder.decode();
      if (buffer.trim())
        throw new LlmEndpointError(
          'endpoint-error',
          'Malformed streaming chunk',
        );
      for (const [, call] of [...calls.entries()].sort(([a], [b]) => a - b)) {
        if (!call.id || !call.name || !call.arguments)
          throw new LlmEndpointError(
            'endpoint-error',
            'Incomplete streamed tool call',
          );
        let args: unknown;
        try {
          args = JSON.parse(call.arguments);
        } catch {
          throw new LlmEndpointError(
            'endpoint-error',
            'Malformed streamed tool-call arguments',
          );
        }
        yield {
          type: 'tool-call',
          id: call.id,
          name: call.name,
          arguments: args,
        };
      }
      if (!gotUsage)
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

  private parseUsage(value: JsonObject) {
    const input = value.prompt_tokens;
    const output = value.completion_tokens;
    if (typeof input !== 'number' || typeof output !== 'number')
      return undefined;
    const details = isObject(value.prompt_tokens_details)
      ? value.prompt_tokens_details
      : {};
    return {
      input,
      output,
      ...(typeof details.cached_tokens === 'number'
        ? { cacheRead: details.cached_tokens }
        : {}),
      estimate: false,
    };
  }
}
