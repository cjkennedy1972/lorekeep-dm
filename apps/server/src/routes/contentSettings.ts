import type { Pool } from 'pg';
import type { registerAuthRoutes } from './auth.js';
import { authenticateRequest } from '../middleware/auth.js';
import { validOrigin } from '../middleware/origin.js';
import { LeaseConflictError, Persistence } from '../persistence/index.js';
import type { RoomRegistry } from '../room/registry.js';

type App = Parameters<typeof registerAuthRoutes>[0];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function registerContentSettingsRoutes(
  app: App,
  db: Pool,
  rooms?: Pick<RoomRegistry, 'peek'>,
) {
  const persistence = new Persistence(db);
  app.patch('/api/me/content-settings', async (request, reply) => {
    if (!validOrigin(request))
      return reply
        .code(403)
        .send({ code: 'BAD_ORIGIN', message: 'Origin not allowed.' });
    const auth = await authenticateRequest(db, request);
    if (!auth)
      return reply.code(401).send({
        code: 'UNAUTHENTICATED',
        message: 'Sign in required.',
        loginRequired: true,
      });
    const matureOptOut = (request.body as { matureOptOut?: unknown } | null)
      ?.matureOptOut;
    if (typeof matureOptOut !== 'boolean')
      return reply.code(400).send({
        code: 'INVALID_INPUT',
        message: 'Choose whether to opt out of mature content.',
      });
    await db.query('UPDATE accounts SET mature_opt_out=$2 WHERE id=$1', [
      auth.account_id,
      matureOptOut,
    ]);
    return { matureOptOut };
  });

  app.patch<{ Params: { id: string } }>(
    '/api/sessions/:id/content-tier',
    async (request, reply) => {
      if (!validOrigin(request))
        return reply
          .code(403)
          .send({ code: 'BAD_ORIGIN', message: 'Origin not allowed.' });
      const auth = await authenticateRequest(db, request);
      if (!auth)
        return reply.code(401).send({
          code: 'UNAUTHENTICATED',
          message: 'Sign in required.',
          loginRequired: true,
        });
      const { id } = request.params;
      if (!UUID.test(id)) return reply.code(404).send({ code: 'NOT_FOUND' });
      const tier = (request.body as { tier?: unknown } | null)?.tier;
      if (tier !== null && tier !== 'family' && tier !== 'standard')
        return reply.code(400).send({
          code: 'INVALID_INPUT',
          message:
            'The host can only lower the table to family or standard, or clear the cap with null.',
        });
      const owner = (
        await db.query<{ owner_account_id: string }>(
          'SELECT owner_account_id FROM sessions WHERE id=$1',
          [id],
        )
      ).rows[0]?.owner_account_id;
      if (!owner) return reply.code(404).send({ code: 'NOT_FOUND' });
      if (owner !== auth.account_id)
        return reply.code(403).send({
          code: 'FORBIDDEN',
          message: 'Only the host can change the table content tier.',
        });
      try {
        const room = rooms?.peek(id);
        if (room) await room.setHostTierCap(tier);
        else await persistence.setHostTierCap(id, tier);
      } catch (error) {
        if (error instanceof LeaseConflictError)
          return reply.code(409).send({
            code: 'SESSION_BUSY',
            message: 'The table is busy. Try the tier change again.',
            retryable: true,
          });
        throw error;
      }
      return { tier };
    },
  );
}
