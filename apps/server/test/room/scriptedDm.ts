import type {
  LlmAdapter,
  LlmChunk,
  LlmRequest,
} from '../../src/llm/adapter.js';

/** A recorded-style adapter: no network. START-COMBAT makes the "DM" call start_combat; unknownthing else narrates. */
export function scriptedDm(requests: LlmRequest[] = []): LlmAdapter {
  return {
    capabilities: () => ({
      streaming: true,
      nativeTools: true,
      jsonSchema: true,
    }),
    probe: async () => true,
    async *complete(request: LlmRequest) {
      requests.push(request);
      const sawTool = request.messages.some((m) => m.role === 'tool');
      const asked = request.messages.some((message) => {
        if (message.content.includes('START-COMBAT')) return true;
        const encoded = message.content.match(
          /<<<PLAYER_DATA encoding=base64>>>\s*([A-Za-z0-9+/=]+)\s*<<<END_PLAYER_DATA>>>/,
        )?.[1];
        return encoded
          ? Buffer.from(encoded, 'base64')
              .toString('utf8')
              .includes('START-COMBAT')
          : false;
      });
      const chunks: LlmChunk[] =
        asked && !sawTool
          ? [
              {
                type: 'tool-call',
                id: 'call_start',
                name: 'start_combat',
                arguments: {
                  enemies: [
                    { monsterId: 'srd:monster/goblin-minion', count: 2 },
                  ],
                  ambushSide: 'party',
                },
              },
            ]
          : [{ type: 'text', delta: 'Steel rings out across the crypt.' }];
      for (const chunk of chunks) yield chunk;
    },
  };
}
