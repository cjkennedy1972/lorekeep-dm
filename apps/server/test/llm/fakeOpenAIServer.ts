import { createServer, type Server } from 'node:http';
import { once } from 'node:events';

export interface FakeServerOptions {
  status?: number;
  chunks?: string[];
  delayMs?: number;
}
export interface FakeOpenAIServer {
  baseUrl: string;
  requests: Array<{
    headers: Record<string, string | string[] | undefined>;
    body: unknown;
  }>;
  close(): Promise<void>;
}

export async function startFakeOpenAIServer(
  options: FakeServerOptions = {},
): Promise<FakeOpenAIServer> {
  const requests: FakeOpenAIServer['requests'] = [];
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
      const safeHeaders = {
        ...request.headers,
        authorization: request.headers.authorization ? 'Bearer ***' : undefined,
      };
      const safeBody =
        body && typeof body === 'object'
          ? { ...(body as Record<string, unknown>), messages: '[redacted]' }
          : '[redacted]';
      requests.push({ headers: safeHeaders, body: safeBody });
      if (options.status) {
        response.writeHead(options.status, {
          'content-type': 'application/json',
        });
        response.end(
          JSON.stringify({ error: { message: 'private endpoint response' } }),
        );
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
    throw new Error('fake server did not bind TCP port');
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

export const textStream = [
  'data: {"choices":[{"index":0,"delta":{"content":"hello "}}]}\n\n',
  'data: {"choices":[{"index":0,"delta":{"content":"world"}}]}\n\n',
  'data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":2,"prompt_tokens_details":{"cached_tokens":3}}}\n\n',
  'data: [DONE]\n\n',
];
