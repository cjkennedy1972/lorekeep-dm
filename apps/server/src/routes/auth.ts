import type { FastifyInstance } from 'fastify';
import type { Server } from 'node:http';
import type { Logger } from 'pino';
import type { Pool } from 'pg';
import type { EmailSender } from '../email/sender.js';
import { signup, signupSchema } from '../accounts/signup.js';
import { verifyEmail } from '../accounts/verify.js';

export function registerAuthRoutes(
  app: FastifyInstance<
    Server,
    import('node:http').IncomingMessage,
    import('node:http').ServerResponse,
    Logger
  >,
  db: Pool,
  sender: EmailSender,
  cookieSecret: string,
  rateLimit = 5,
) {
  const hits = new Map<string, { count: number; reset: number }>();
  function limited(key: string): boolean {
    const now = Date.now();
    const item = hits.get(key);
    if (!item || item.reset <= now) {
      hits.set(key, { count: 1, reset: now + 60_000 });
      return false;
    }
    item.count++;
    return item.count > rateLimit;
  }
  app.post('/api/signup', async (request, reply) => {
    const parsed = signupSchema.safeParse(request.body);
    if (!parsed.success)
      return reply.code(400).send({ message: 'Invalid signup details' });
    const email = parsed.data.email.trim().toLowerCase();
    if (limited(`ip:${request.ip}`) || limited(`email:${email}`))
      return reply.code(429).send({ message: 'Too many requests' });
    try {
      const result = await signup(db, sender, parsed.data, {
        cookieSecret,
        cookie: request.headers.cookie,
      });
      if (result.retryBlockCookie)
        reply.header('set-cookie', result.retryBlockCookie);
      return reply.code(202).send(result.response);
    } catch (error) {
      if (error instanceof RangeError)
        return reply.code(400).send({ message: 'Invalid signup details' });
      throw error;
    }
  });
  const verify = async (
    request: { query?: unknown; body?: unknown },
    reply: { code: (status: number) => { send: (body: unknown) => unknown } },
  ) => {
    const source = request.body ?? request.query;
    const token =
      typeof source === 'object' && source !== null && 'token' in source
        ? source.token
        : undefined;
    const ok = typeof token === 'string' && (await verifyEmail(db, token));
    return reply.code(ok ? 200 : 400).send({
      message: ok ? 'Email verified' : 'Invalid or expired verification link',
    });
  };
  app.get('/api/verify-email', verify);
  app.post('/api/verify-email', verify);
}
