import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';

// Stands in for the operator's `moderate` endpoint (OpenAI-compatible, streamed). Judge
// prompts get the strict JSON verdict; anything else gets narration.
export class ModerationStub {
  verdict: 'allow' | 'block' = 'allow';
  judgeCalls = 0;
  private server?: Server;
  private port = 0;

  get baseUrl(): string {
    return `http://127.0.0.1:${this.port}/v1`;
  }

  async start(): Promise<void> {
    if (this.server) return;
    const server = createServer((req, res) => this.handle(req, res));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.port, '127.0.0.1', () => resolve());
    });
    this.port = (server.address() as AddressInfo).port;
    this.server = server;
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (!server) return;
    this.server = undefined;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private handle(req: IncomingMessage, res: ServerResponse) {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
        res.writeHead(404).end();
        return;
      }
      const { messages = [] } = JSON.parse(body || '{}') as {
        messages?: { content?: string }[];
      };
      let content = 'The crypt is quiet.';
      if (String(messages[0]?.content ?? '').startsWith('You are moderating')) {
        this.judgeCalls++;
        content =
          this.verdict === 'block'
            ? JSON.stringify({ verdict: 'block', category: 'language' })
            : JSON.stringify({ verdict: 'allow', category: 'none' });
      }
      const chunk = (delta: object, finish: 'stop' | null) =>
        `data: ${JSON.stringify({ id: 'e2e', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(chunk({ role: 'assistant', content }, null));
      res.write(chunk({}, 'stop'));
      res.end('data: [DONE]\n\n');
    });
  }
}
