import type { FastifyInstance } from 'fastify';
import type { Server } from 'node:http';
import type { Logger } from 'pino';
import type { Pool } from 'pg';
import type { EgressGuard } from '../llm/egress.js';
import { z } from 'zod';
import {
  publicContext,
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
  recordDeniedAttempt,
  saveEndpoint,
  testEndpoint,
  type EndpointSlot,
} from '../llm/config.js';
import {
  configuredSoloEndpointSlot,
  verifiedMatureEndpointGrant,
} from '../llm/matureEndpoint.js';

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
  // ponytail: per-process daily counter; N nodes allow N× the cap. Move to a DB count if that matters.
  const DENIED_ROWS_PER_CALLER_PER_DAY = 100;
  let deniedDay = '';
  const deniedRows = new Map<string, number>();
  const auditDenied = async (
    request: Parameters<typeof authenticateRequest>[1],
    actorId: string | null,
    reason: string,
  ) => {
    const day = new Date().toISOString().slice(0, 10);
    if (day !== deniedDay) {
      deniedDay = day;
      deniedRows.clear();
    }
    const key = actorId ?? 'anonymous';
    const seen = deniedRows.get(key) ?? 0;
    if (seen >= DENIED_ROWS_PER_CALLER_PER_DAY) return;
    deniedRows.set(key, seen + 1);
    const { slot } = request.params as { slot?: string };
    try {
      await recordDeniedAttempt(db, {
        actorId,
        slot: ENDPOINT_SLOTS.includes(slot as EndpointSlot)
          ? (slot as EndpointSlot)
          : null,
        reason,
        details: {
          method: request.method,
          route: request.routeOptions.url ?? '',
        },
      });
    } catch (error) {
      request.log.warn({ err: error }, 'operator denial audit write failed');
    }
  };
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
      await auditDenied(
        request,
        session?.account_id ?? null,
        session ? 'NOT_OPERATOR' : 'UNAUTHENTICATED',
      );
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
      ) {
        await auditDenied(request, session.account_id, 'INVALID_ENDPOINT_URL');
        return reply.code(400).send({ code: 'INVALID_ENDPOINT_URL' });
      }
      if (error instanceof Error && error.message === 'KEY_REQUIRED') {
        await auditDenied(request, session.account_id, 'KEY_REQUIRED');
        return reply.code(400).send({ code: 'KEY_REQUIRED' });
      }
      if (
        error instanceof Error &&
        error.message === 'Endpoint credential unavailable'
      ) {
        await auditDenied(
          request,
          session.account_id,
          'CREDENTIAL_UNAVAILABLE',
        );
        return reply.code(503).send({ code: 'CREDENTIAL_UNAVAILABLE' });
      }
      if (error instanceof Error && error.name === 'ZodError') {
        await auditDenied(request, session.account_id, 'INVALID_INPUT');
        return reply.code(400).send({ code: 'INVALID_INPUT' });
      }
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
  app.patch<{ Params: { id: string } }>(
    '/api/operator/sessions/:id/mature-endpoint',
    async (request, reply) => {
      const session = await authorize(request, reply);
      if (!session) return;
      const { id } = request.params;
      if (!z.uuid().safeParse(id).success)
        return reply.code(404).send({ code: 'NOT_FOUND' });
      const body = z
        .object({
          enabled: z.boolean(),
          policyAcknowledgement: z
            .literal(
              'I_CONFIRM_NARRATION_AND_MODERATION_ENDPOINT_POLICIES_ALLOW_MATURE',
            )
            .optional(),
        })
        .strict()
        .safeParse(request.body);
      if (!body.success) return reply.code(400).send({ code: 'INVALID_INPUT' });
      const slot = configuredSoloEndpointSlot();
      let fingerprint: string | null = null;
      let moderationFingerprint: string | null = null;
      if (body.data.enabled) {
        if (
          body.data.policyAcknowledgement !==
          'I_CONFIRM_NARRATION_AND_MODERATION_ENDPOINT_POLICIES_ALLOW_MATURE'
        )
          return reply.code(400).send({
            code: 'POLICY_ACKNOWLEDGEMENT_REQUIRED',
            message:
              'An operator must explicitly confirm that both configured narration and moderation endpoint policies permit this product’s mature tier.',
          });
        const endpointGrant = await verifiedMatureEndpointGrant(db, slot);
        if (!endpointGrant)
          return reply.code(409).send({
            code: 'ENDPOINT_PROBE_REQUIRED',
            message:
              'The narration endpoint probe must show reachability, streaming, and a supported structured-call mode; the moderation endpoint probe must show reachability and streaming. The selected narration mode already enforces its 95% valid-call threshold. This technical check does not establish policy permission.',
          });
        fingerprint = endpointGrant.narrationFingerprint;
        moderationFingerprint = endpointGrant.moderationFingerprint;
      }
      const client = await db.connect();
      try {
        await client.query('BEGIN');
        const updated = await client.query(
          `UPDATE sessions
              SET endpoint_allows_mature=$2,
                  moderation_verified=$2,
                  endpoint_mature_fingerprint=$3,
                  moderation_mature_fingerprint=$4
            WHERE id=$1`,
          [id, body.data.enabled, fingerprint, moderationFingerprint],
        );
        if (!updated.rowCount) {
          await client.query('ROLLBACK');
          return reply.code(404).send({ code: 'NOT_FOUND' });
        }
        await client.query(
          'INSERT INTO operator_endpoint_audit(slot,action,actor_id,details) VALUES($1,$2,$3,$4::jsonb)',
          [
            slot,
            body.data.enabled ? 'mature_enabled' : 'mature_disabled',
            session.account_id,
            JSON.stringify({
              sessionId: id,
              narrationEndpointSlot: slot,
              moderationEndpointSlot: 'moderate',
              narrationEndpointFingerprint: fingerprint,
              moderationEndpointFingerprint: moderationFingerprint,
            }),
          ],
        );
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
      return {
        enabled: body.data.enabled,
        narrationEndpointSlot: slot,
        moderationEndpointSlot: 'moderate',
      };
    },
  );
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
    const result = await db.query<{ context: Array<Record<string, unknown>> }>(
      `SELECT id,session_id,message_seq,reporter_account_id,author_account_id,category,reason,context,status,created_at,expires_at,reviewed_by,reviewed_at
       FROM message_reports WHERE status=$1 ORDER BY created_at DESC, id LIMIT $2 OFFSET $3`,
      [status, limit, offset],
    );
    return {
      reports: result.rows.map((row) => ({
        ...row,
        context: publicContext(row.context),
      })),
    };
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
        'INSERT INTO message_report_audit(report_id,actor_id,from_status,to_status) VALUES($1,$2,$3,$4)',
        [id, session.account_id, prev.status, to],
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
