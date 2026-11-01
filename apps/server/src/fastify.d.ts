import type { IncomingMessage } from 'node:http';

declare module 'fastify' {
  interface FastifyInstance {
    clientIpForUpgrade(request: IncomingMessage): string;
  }
}
