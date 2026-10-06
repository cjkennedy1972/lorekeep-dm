import Fastify from 'fastify';
import type { Pool } from 'pg';
import pino, { type DestinationStream } from 'pino';
import { startSpan } from './telemetry.js';
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
];
export function createLogger(stream?: DestinationStream) {
  return pino(
    {
      redact: { paths: redact, censor: '[REDACTED]' },
      serializers: {
        req: (req: { method: string; url: string; id: string }) => ({
          method: req.method,
          url: req.url.split('?', 1)[0],
          id: req.id,
        }),
      },
    },
    stream,
  );
}
export function createApp(db: Pick<Pool, 'query'>) {
  const app = Fastify({
    loggerInstance: createLogger(),
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
          'url.path': request.url.split('?', 1)[0],
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
  app.get('/healthz', async () => ({ status: 'ok' }));
  app.get('/readyz', async (_request, reply) => {
    try {
      await db.query('SELECT 1');
      return { status: 'ready' };
    } catch {
      return reply.code(503).send({ status: 'unavailable' });
    }
  });
  return app;
}
