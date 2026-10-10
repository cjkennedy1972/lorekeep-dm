import { describe, expect, it } from 'vitest';
import type { LlmMessage } from '../../src/llm/adapter.js';
import { Secret } from '../../src/llm/secret.js';
import { OpenAICompatibleAdapter } from '../../src/llm/dialects/openai.js';
import { AnthropicMessagesAdapter } from '../../src/llm/dialects/anthropic.js';

const replay: LlmMessage[] = [
  { role: 'user', content: 'attack the goblin' },
  {
    role: 'assistant',
    content: '',
    toolCalls: [
      {
        id: 'call_1',
        name: 'attack',
        arguments: { attackerId: 'ent_ayla', targetId: 'ent_goblin' },
      },
    ],
  },
  {
    role: 'tool',
    name: 'attack',
    toolCallId: 'call_1',
    content: '{"ok":true}',
  },
];

function capturingEgress(): {
  egress: { fetch(url: string, init?: RequestInit): Promise<Response> };
  bodies: Record<string, unknown>[];
} {
  const bodies: Record<string, unknown>[] = [];
  return {
    bodies,
    egress: {
      async fetch(_url, init) {
        bodies.push(JSON.parse(String(init?.body)));
        return new Response('data: [DONE]\n\n', {
          headers: { 'content-type': 'text/event-stream' },
        });
      },
    },
  };
}

async function drain(stream: AsyncIterable<unknown>) {
  try {
    for await (const chunk of stream) void chunk;
  } catch {
    // An empty stream may end in an endpoint error; the body is still captured.
  }
}

describe('DM tool-call replay on the wire', () => {
  it('OpenAI: assistant turn carries tool_calls and the tool result cites the same id', async () => {
    const { egress, bodies } = capturingEgress();
    const adapter = new OpenAICompatibleAdapter({
      baseUrl: 'http://127.0.0.1:1',
      model: 'fixture-model',
      apiKey: new Secret('test-secret'),
      egress,
      timeoutMs: 500,
    });
    await drain(adapter.complete({ messages: replay, maxTokens: 10 }));
    const messages = bodies[0]?.messages as Record<string, unknown>[];
    expect(messages[1]).toStrictEqual({
      role: 'assistant',
      content: '',
      tool_calls: [
        {
          id: 'call_1',
          type: 'function',
          function: {
            name: 'attack',
            arguments: '{"attackerId":"ent_ayla","targetId":"ent_goblin"}',
          },
        },
      ],
    });
    expect(messages[2]).toStrictEqual({
      role: 'tool',
      content: '{"ok":true}',
      name: 'attack',
      tool_call_id: 'call_1',
    });
  });

  it('Anthropic: assistant turn carries a tool_use block and the result is a tool_result in the next user turn', async () => {
    const { egress, bodies } = capturingEgress();
    const adapter = new AnthropicMessagesAdapter({
      baseUrl: 'http://127.0.0.1:1',
      model: 'fixture-model',
      apiKey: new Secret('test-secret'),
      cache: false,
      egress,
      timeoutMs: 500,
    });
    await drain(adapter.complete({ messages: replay, maxTokens: 10 }));
    const messages = bodies[0]?.messages as Record<string, unknown>[];
    expect(messages).toStrictEqual([
      { role: 'user', content: 'attack the goblin' },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'call_1',
            name: 'attack',
            input: { attackerId: 'ent_ayla', targetId: 'ent_goblin' },
          },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'call_1',
            content: '{"ok":true}',
          },
        ],
      },
    ]);
  });
});
