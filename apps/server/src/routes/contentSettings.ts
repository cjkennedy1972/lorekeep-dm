import type { Pool } from 'pg';
import type { registerAuthRoutes } from './auth.js';
import { authenticateRequest } from '../middleware/auth.js';
import { validOrigin } from '../middleware/origin.js';
import { LeaseConflictError, Persistence } from '../persistence/index.js';
import type { RoomRegistry } from '../room/registry.js';
import { z } from 'zod';

type App = Parameters<typeof registerAuthRoutes>[0];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const boundary = z
  .string()
  .trim()
  .min(1)
  .max(160)
  .refine((value) =>
    [...value].every((char) => {
      const code = char.charCodeAt(0);
      return code >= 0x20 && code !== 0x7f;
    }),
  );
const personalContentSettings = z
  .object({
    matureOptOut: z.boolean().optional(),
    lines: z.array(boundary).max(20).optional(),
    veils: z.array(boundary).max(20).optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.matureOptOut !== undefined ||
      value.lines !== undefined ||
      value.veils !== undefined,
  );

const uniqueBoundaries = (values: string[] | undefined) =>
  values === undefined
    ? undefined
    : [...new Set(values.map((value) => value.trim()))];

export function registerContentSettingsRoutes(
  app: App,
  db: Pool,
  rooms?: Pick<RoomRegistry, 'peek'>,
) {
  const persistence = new Persistence(db);
  app.get('/api/me/content-settings', async (request, reply) => {
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
    const result = await db.query<{
      mature_opt_out: boolean;
      content_lines: string[];
      content_veils: string[];
    }>(
      'SELECT mature_opt_out,content_lines,content_veils FROM accounts WHERE id=$1',
      [auth.account_id],
    );
    const row = result.rows[0];
    if (!row) return reply.code(404).send({ code: 'NOT_FOUND' });
    return {
      matureOptOut: row.mature_opt_out,
      lines: row.content_lines,
      veils: row.content_veils,
    };
  });

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
    const parsed = personalContentSettings.safeParse(request.body);
    if (!parsed.success)
      return reply.code(400).send({
        code: 'INVALID_INPUT',
        message: 'Check your content settings and boundary text.',
      });
    const matureOptOut = parsed.data.matureOptOut ?? null;
    const lines = uniqueBoundaries(parsed.data.lines) ?? null;
    const veils = uniqueBoundaries(parsed.data.veils) ?? null;
    await db.query(
      `UPDATE accounts
          SET mature_opt_out=COALESCE($2,mature_opt_out),
              content_lines=COALESCE($3,content_lines),
              content_veils=COALESCE($4,content_veils)
        WHERE id=$1`,
      [auth.account_id, matureOptOut, lines, veils],
    );
    return {
      ...(parsed.data.matureOptOut === undefined ? {} : { matureOptOut }),
      ...(lines === null ? {} : { lines }),
      ...(veils === null ? {} : { veils }),
    };
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

  app.patch<{ Params: { id: string } }>(
    '/api/sessions/:id/x-card-abort',
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
      const enabled = (request.body as { enabled?: unknown } | null)?.enabled;
      if (typeof enabled !== 'boolean')
        return reply.code(400).send({
          code: 'INVALID_INPUT',
          message: 'Choose whether X-cards abort in-flight narration.',
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
          message: 'Only the host can change X-card abort behavior.',
        });
      try {
        const room = rooms?.peek(id);
        if (room) await room.setXCardAbortEnabled(enabled);
        else await persistence.setXCardAbortEnabled(id, enabled);
      } catch (error) {
        if (error instanceof LeaseConflictError)
          return reply.code(409).send({
            code: 'SESSION_BUSY',
            message: 'The table is busy. Try the setting change again.',
            retryable: true,
          });
        throw error;
      }
      return { enabled };
    },
  );
}
