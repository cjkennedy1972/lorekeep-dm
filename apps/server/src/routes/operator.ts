import type { FastifyInstance } from 'fastify';
import type { Server } from 'node:http';
import type { Logger } from 'pino';
import type { Pool } from 'pg';
import type { EgressGuard } from '../llm/egress.js';
import { z } from 'zod';
import {
  REPORT_TRANSITIONS,
  reportPatchSchema,
  reportQuerySchema,
  type ReportStatus,
} from './reports.js';
import { authenticateRequest } from '../middleware/auth.js';
import { validOrigin } from '../middleware/origin.js';
import {
  createEndpointEgress,
  deleteEndpoint,
  ENDPOINT_SLOTS,
  isOperatorAccount,
  readEndpoints,
  saveEndpoint,
  testEndpoint,
  type EndpointSlot,
} from '../llm/config.js';

export function registerOperatorRoutes(
  app: FastifyInstance<
    Server,
    import('node:http').IncomingMessage,
    import('node:http').ServerResponse,
    Logger
  >,
  db: Pool,
  isOperator = (id: string) => isOperatorAccount(db, id),
  dependencies: { egress?: EgressGuard } = {},
) {
  const egress = dependencies.egress ?? createEndpointEgress();
  app.addHook('onRequest', async (request, reply) => {
    if (!validOrigin(request))
      return reply
        .code(403)
        .send({ code: 'BAD_ORIGIN', message: 'Origin not allowed.' });
  });
  const authorize = async (
    request: Parameters<typeof authenticateRequest>[1],
    reply: { code: (status: number) => { send: (body: unknown) => unknown } },
  ): Promise<Awaited<ReturnType<typeof authenticateRequest>>> => {
    const session = await authenticateRequest(db, request);
    if (!session || !(await isOperator(session.account_id))) {
      reply.code(404).send({ code: 'NOT_FOUND' });
      return undefined;
    }
    return session;
  };
  app.get('/api/operator/endpoints', async (request, reply) => {
    const session = await authorize(request, reply);
    if (!session) return;
    return { endpoints: await readEndpoints(db) };
  });
  app.put('/api/operator/endpoints/:slot', async (request, reply) => {
    const session = await authorize(request, reply);
    if (!session) return;
    const { slot } = request.params as { slot: string };
    if (!ENDPOINT_SLOTS.includes(slot as EndpointSlot))
      return reply.code(400).send({ code: 'INVALID_SLOT' });
    try {
      return {
        endpoint: await saveEndpoint(
          db,
          slot as EndpointSlot,
          request.body,
          egress,
          session.account_id,
        ),
      };
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === 'Endpoint URL is not allowed'
      )
        return reply.code(400).send({ code: 'INVALID_ENDPOINT_URL' });
      if (error instanceof Error && error.message === 'KEY_REQUIRED')
        return reply.code(400).send({ code: 'KEY_REQUIRED' });
      if (
        error instanceof Error &&
        error.message === 'Endpoint credential unavailable'
      )
        return reply.code(503).send({ code: 'CREDENTIAL_UNAVAILABLE' });
      if (error instanceof Error && error.name === 'ZodError')
        return reply.code(400).send({ code: 'INVALID_INPUT' });
      throw error;
    }
  });
  app.post('/api/operator/endpoints/:slot/test', async (request, reply) => {
    const session = await authorize(request, reply);
    if (!session) return;
    const { slot } = request.params as { slot: string };
    if (!ENDPOINT_SLOTS.includes(slot as EndpointSlot))
      return reply.code(400).send({ code: 'INVALID_SLOT' });
    try {
      return {
        probe: await testEndpoint(
          db,
          slot as EndpointSlot,
          egress,
          session.account_id,
        ),
      };
    } catch {
      return reply.code(503).send({ code: 'PROBE_FAILED' });
    }
  });
  app.delete('/api/operator/endpoints/:slot', async (request, reply) => {
    const session = await authorize(request, reply);
    if (!session) return;
    const { slot } = request.params as { slot: string };
    if (!ENDPOINT_SLOTS.includes(slot as EndpointSlot))
      return reply.code(400).send({ code: 'INVALID_SLOT' });
    const deleted = await deleteEndpoint(
      db,
      slot as EndpointSlot,
      session.account_id,
    );
    return deleted
      ? { deleted: true }
      : reply.code(404).send({ code: 'NOT_FOUND' });
  });
  app.get('/api/operator/reports', async (request, reply) => {
    const session = await authorize(request, reply);
    if (!session) return;
    const query = reportQuerySchema.safeParse(request.query);
    if (!query.success) return reply.code(400).send({ code: 'INVALID_INPUT' });
    const { status, limit, offset } = query.data;
    const result = await db.query(
      `SELECT id,session_id,message_seq,reporter_account_id,author_account_id,category,reason,context,status,created_at,expires_at,reviewed_by,reviewed_at
       FROM message_reports WHERE status=$1 ORDER BY created_at DESC, id LIMIT $2 OFFSET $3`,
      [status, limit, offset],
    );
    return { reports: result.rows };
  });
  app.patch('/api/operator/reports/:id', async (request, reply) => {
    const session = await authorize(request, reply);
    if (!session) return;
    const { id } = request.params as { id: string };
    const body = reportPatchSchema.safeParse(request.body);
    if (!z.uuid().safeParse(id).success)
      return reply.code(404).send({ code: 'NOT_FOUND' });
    if (!body.success) return reply.code(400).send({ code: 'INVALID_INPUT' });
    const to = body.data.status;
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const prev = (
        await client.query<{ status: ReportStatus }>(
          'SELECT status FROM message_reports WHERE id=$1 FOR UPDATE',
          [id],
        )
      ).rows[0];
      if (!prev || !REPORT_TRANSITIONS[prev.status].includes(to)) {
        await client.query('ROLLBACK');
        return prev
          ? reply.code(409).send({
              code: 'INVALID_TRANSITION',
              message: `A ${prev.status} report cannot become ${to}.`,
            })
          : reply.code(404).send({ code: 'NOT_FOUND' });
      }
      const report = (
        await client.query(
          `UPDATE message_reports
           SET status=$2::text,
               reviewed_by=CASE WHEN $2::text='open' THEN NULL ELSE $3::uuid END,
               reviewed_at=CASE WHEN $2::text='open' THEN NULL ELSE now() END,
               expires_at=CASE WHEN $2::text='open' THEN now() + interval '90 days' ELSE now() + interval '30 days' END
           WHERE id=$1
           RETURNING id,status,reviewed_by,reviewed_at,expires_at`,
          [id, to, session.account_id],
        )
      ).rows[0];
      await client.query(
        'INSERT INTO message_report_audit(report_id,actor_id,from_status,to_status,expires_at) VALUES($1,$2,$3,$4,$5)',
        [id, session.account_id, prev.status, to, report.expires_at],
      );
      await client.query('COMMIT');
      return { report };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  });
}
