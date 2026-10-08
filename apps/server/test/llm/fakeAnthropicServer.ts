import { createServer, type Server } from 'node:http';
import { once } from 'node:events';

export interface FakeAnthropicOptions {
  status?: number;
  chunks?: string[];
  delayMs?: number;
}
export interface FakeAnthropicServer {
  baseUrl: string;
  requests: Array<{
    headers: Record<string, string | string[] | undefined>;
    body: unknown;
  }>;
  close(): Promise<void>;
}
export async function startFakeAnthropicServer(
  options: FakeAnthropicOptions = {},
): Promise<FakeAnthropicServer> {
  const requests: FakeAnthropicServer['requests'] = [];
  const server: Server = createServer((request, response) => {
    const parts: Buffer[] = [];
    request.on('data', (part: Buffer) => parts.push(part));
    request.on('end', () => {
      let body: unknown;
      try {
        body = JSON.parse(Buffer.concat(parts).toString('utf8'));
      } catch {
        body = undefined;
      }
      requests.push({
        headers: {
          ...request.headers,
          'x-api-key': request.headers['x-api-key'] ? '[REDACTED]' : undefined,
        },
        body:
          body && typeof body === 'object'
            ? { ...(body as Record<string, unknown>), messages: '[redacted]' }
            : '[redacted]',
      });
      if (options.status) {
        response.writeHead(options.status, {
          'content-type': 'application/json',
        });
        response.end('{"error":{"message":"private endpoint response"}}');
        return;
      }
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        connection: 'keep-alive',
      });
      const send = () => {
        for (const chunk of options.chunks ?? []) response.write(chunk);
        if (!options.delayMs) response.end();
      };
      if (options.delayMs) setTimeout(send, options.delayMs);
      else send();
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('fake endpoint failed to bind');
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    close: async () => {
      server.closeAllConnections();
      server.close();
      await once(server, 'close');
    },
  };
}
export const anthropicStream = [
  'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":10,"output_tokens":0,"cache_read_input_tokens":3,"cache_creation_input_tokens":2}}}\n\n',
  'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":"hello "}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"world"}}\n\n',
  'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"tool_1","name":"request_check","input":{}}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"dc\\":"}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"15,\\"ability\\":\\"dex\\"}"}}\n\n',
  'event: content_block_stop\ndata: {"type":"content_block_stop","index":1}\n\n',
  'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":4}}\n\n',
];
