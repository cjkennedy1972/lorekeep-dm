import Fastify, { type FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import pino, { type DestinationStream } from 'pino';
import { startSpan } from './telemetry.js';
import { ConsoleEmailSender, type EmailSender } from './email/sender.js';
import { registerAuthRoutes } from './routes/auth.js';
import { isDevelopmentOrTest } from './accounts/sessions.js';
import { registerSessionRoutes } from './routes/sessions.js';
import { registerTableRoutes } from './routes/tables.js';
import { retentionHealth } from './retention/sweeper.js';
import { registerUsageRoutes } from './llm/usageRoutes.js';
import { registerOperatorRoutes } from './routes/operator.js';
import { registerReportRoutes } from './routes/reports.js';
import { registerContentSettingsRoutes } from './routes/contentSettings.js';
import type { RoomRegistry } from './room/registry.js';
import type { ConnectionRegistry } from './gateway/connections.js';

/** Invite codes travel in the URL path; never log or trace them. */
export const scrubUrl = (url: string) =>
  url
    .split('?', 1)[0]!
    .replace(/(\/api\/(?:invites|join)\/)[^/]+/, '$1[REDACTED]');
const redact = [
  'req.headers.cookie',
  'req.headers.authorization',
  'headers.cookie',
  'cookie',
  'cookies',
  '*.cookie',
  '*.cookies',
  'password',
  '*.password',
  'token',
  '*.token',
  'accessToken',
  '*.accessToken',
  'refreshToken',
  '*.refreshToken',
  'birthdate',
  '*.birthdate',
  'dob',
  '*.dob',
  'apiKey',
  '*.apiKey',
  'LLM_API_KEY',
  '*.LLM_API_KEY',
  'req.headers["x-api-key"]',
];
export function createLogger(stream?: DestinationStream) {
  return pino(
    {
      redact: { paths: redact, censor: '[REDACTED]' },
      serializers: {
        req: (req: { method: string; url: string; id: string }) => ({
          method: req.method,
          url: scrubUrl(req.url),
          id: req.id,
        }),
      },
    },
    stream,
  );
}
export function createApp(
  db: Pick<Pool, 'query'> & Partial<Pool>,
  options: {
    sender?: EmailSender;
    cookieSecret?: string;
    rateLimit?: number;
    joinRateLimit?: number;
    roomLimits?: { maxRooms?: number; createPerHour?: number };
    rooms?: Pick<RoomRegistry, 'get' | 'peek'>;
    connections?: Pick<ConnectionRegistry, 'sweep'>;
    isOperator?: (accountId: string) => Promise<boolean>;
    trustProxy?: boolean | number | string[];
    liveDmAllowlistOnly?: boolean;
  } = {},
) {
  const { trustProxy = false, liveDmAllowlistOnly = true } = options;
  // ponytail: Fastify 5 ignores numeric trustProxy (fails closed), so count hops here; hop 0 is the socket peer.
  const app = Fastify({
    loggerInstance: createLogger(),
    trustProxy:
      typeof trustProxy === 'number'
        ? (_address: string, hop: number) => hop < trustProxy
        : trustProxy,
    requestIdHeader: 'x-request-id',
    genReqId: () => crypto.randomUUID(),
  });
  const spans = new WeakMap<object, ReturnType<typeof startSpan>>();
  app.addHook('onRequest', (request, _reply, done) => {
    spans.set(
      request,
      startSpan('http.request', {
        attributes: {
          'http.request.method': request.method,
          'url.path': scrubUrl(request.url),
        },
      }),
    );
    done();
  });
  app.addHook('onResponse', (request, reply, done) => {
    const span = spans.get(request);
    span?.setAttribute('http.response.status_code', reply.statusCode);
    span?.end();
    done();
  });
  app.addHook('onError', (request, _reply, error, done) => {
    spans.get(request)?.recordException(error);
    done();
  });
  if (db.connect) {
    const cookieSecret = options.cookieSecret ?? process.env.AGE_RETRY_SECRET;
    if (!cookieSecret && !isDevelopmentOrTest())
      throw new Error('AGE_RETRY_SECRET is required');
    registerAuthRoutes(
      app,
      db as Pool,
      options.sender ?? new ConsoleEmailSender(),
      cookieSecret ?? 'development-only-secret',
      options.rateLimit,
      options.connections,
    );
    registerUsageRoutes(app, db as Pool, options.isOperator);
    registerOperatorRoutes(app, db as Pool, options.isOperator);
    registerReportRoutes(app, db as Pool);
    registerContentSettingsRoutes(app, db as Pool, options.rooms);
    if (options.rooms) {
      registerSessionRoutes(
        app,
        db as Pool,
        options.rooms,
        options.joinRateLimit,
        options.roomLimits,
      );
      registerTableRoutes(
        app as unknown as FastifyInstance,
        db as Pool,
        options.rooms as Pick<RoomRegistry, 'get'>,
        liveDmAllowlistOnly,
      );
    }
  }
  app.get('/healthz', async () => ({ status: 'ok' }));
  app.get('/readyz', async (_request, reply) => {
    try {
      await db.query('SELECT 1');
      const retention = await retentionHealth(db).catch(() => undefined);
      return { status: 'ready', retention };
    } catch {
      return reply.code(503).send({ status: 'unavailable' });
    }
  });
  return app;
}
