import type { FastifyInstance } from 'fastify';
import type { Server } from 'node:http';
import type { Logger } from 'pino';
import type { Pool } from 'pg';
import type { EgressGuard } from '../llm/egress.js';
import { authenticateRequest } from '../middleware/auth.js';
import {
  createEndpointEgress,
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
  const authorize = async (
    request: Parameters<typeof authenticateRequest>[1],
    reply: { code: (status: number) => { send: (body: unknown) => unknown } },
  ) => {
    const session = await authenticateRequest(db, request);
    if (!session || !(await isOperator(session.account_id)))
      return reply.code(404).send({ code: 'NOT_FOUND' });
    return undefined;
  };
  app.get('/api/operator/endpoints', async (request, reply) => {
    const denied = await authorize(request, reply);
    if (denied) return denied;
    return { endpoints: await readEndpoints(db) };
  });
  app.put('/api/operator/endpoints/:slot', async (request, reply) => {
    const denied = await authorize(request, reply);
    if (denied) return denied;
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
        ),
      };
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === 'Endpoint URL is not allowed'
      )
        return reply.code(400).send({ code: 'INVALID_ENDPOINT_URL' });
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
    const denied = await authorize(request, reply);
    if (denied) return denied;
    const { slot } = request.params as { slot: string };
    if (!ENDPOINT_SLOTS.includes(slot as EndpointSlot))
      return reply.code(400).send({ code: 'INVALID_SLOT' });
    try {
      return { probe: await testEndpoint(db, slot as EndpointSlot, egress) };
    } catch {
      return reply.code(503).send({ code: 'PROBE_FAILED' });
    }
  });
}
