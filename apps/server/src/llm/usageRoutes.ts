import type { registerAuthRoutes } from '../routes/auth.js';
import type { Pool } from 'pg';
import { authenticateRequest } from '../middleware/auth.js';
import { readUsage } from './metering.js';

export function registerUsageRoutes(
  app: Parameters<typeof registerAuthRoutes>[0],
  db: Pool,
  isOperator: (accountId: string) => Promise<boolean> = async () => false,
) {
  app.get('/api/operator/usage', async (request, reply) => {
    const session = await authenticateRequest(db, request);
    if (!session) return reply.code(401).send({ code: 'UNAUTHENTICATED' });
    if (!(await isOperator(session.account_id)))
      return reply.code(403).send({ code: 'FORBIDDEN' });
    const query = request.query as { sessionId?: string };
    if (query.sessionId && !/^[0-9a-f-]{36}$/i.test(query.sessionId))
      return reply.code(400).send({ code: 'INVALID_SESSION_ID' });
    return { usage: await readUsage(db, query.sessionId) };
  });
}
