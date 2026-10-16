import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
export function validOrigin(request: FastifyRequest): boolean {
  if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return true;
  const origin = request.headers.origin;
  if (!origin) return true; // non-browser clients cannot be induced to send cookies cross-site
  try {
    const parsed = new URL(origin);
    return parsed.origin === `${request.protocol}://${request.headers.host}`;
  } catch {
    return false;
  }
}

export async function originGuard(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  if (!validOrigin(request))
    return reply
      .code(403)
      .send({ code: 'BAD_ORIGIN', message: 'Origin not allowed.' });
}

/** Routes registered inside `register` are origin-checked; routes on `app` itself are not. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- root logger type varies per createApp/tests
export function originScope<T extends FastifyInstance<any, any, any, any, any>>(
  app: T,
  register: (scope: T) => void,
) {
  app.register(async (scope) => {
    scope.addHook('onRequest', originGuard);
    register(scope as unknown as T);
  });
}
