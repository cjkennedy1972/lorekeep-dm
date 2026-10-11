import { randomUUID } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import type { registerAuthRoutes } from './auth.js';
import type { Pool } from 'pg';
import { CreateRoomInputSchema, type RoomInfo } from '@game/schema';
import { authenticateRequest } from '../middleware/auth.js';
import { tokenFromCookie } from '../accounts/sessions.js';
import { hashToken } from '../accounts/signup.js';
import {
  restoreForMember,
  revokeInvite,
  sessionForCode,
  setInvite,
} from '../rooms/invites.js';
import type { RoomRegistry } from '../room/registry.js';
import { BoundedCounter } from '../accounts/throttle.js';

type Seater = Pick<RoomRegistry, 'get'>;
const JOIN_LIMIT = 10;
export const MAX_ACTIVE_ROOMS = 20;
const CREATE_PER_HOUR = 10;
export const ROOM_LIST_SQL = `SELECT s.id,s.name,s.owner_account_id=$1 AS is_host FROM sessions s
  WHERE s.status='active' AND (s.owner_account_id=$1 OR EXISTS (
    SELECT 1 FROM events e WHERE e.session_id=s.id AND e.type='SeatJoined' AND e.payload->>'accountId'=$1::text))`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Room endpoints. `/api/rooms` is what the web calls; `/api/sessions` and `/api/join/:code` are the ticket's names. */
export function registerSessionRoutes(
  app: Parameters<typeof registerAuthRoutes>[0],
  db: Pool,
  rooms: Seater,
  joinLimit = JOIN_LIMIT,
  limits: { maxRooms?: number; createPerHour?: number } = {},
) {
  const maxRooms = limits.maxRooms ?? MAX_ACTIVE_ROOMS;
  const createPerHour = limits.createPerHour ?? CREATE_PER_HOUR;
  const createHits = new BoundedCounter(3_600_000);
  const joinHits = new BoundedCounter(60_000);
  const throttled = (key: string) => joinHits.hit(key) > joinLimit;
  // ponytail: in-process map, move to shared store when running >1 node.
  /** Resolves the signed-in account, or sends 401 (anonymous) / 403 (account exists but is unverified). */
  async function member(
    request: FastifyRequest,
    reply: import('fastify').FastifyReply,
  ) {
    const auth = await authenticateRequest(db, request);
    if (auth) return auth.account_id;
    const code = (request.params as { code?: string } | undefined)?.code;
    const token = tokenFromCookie(request.headers.cookie);
    const pending = token
      ? await db.query(
          `SELECT 1 FROM auth_sessions s JOIN accounts a ON a.id=s.account_id
            WHERE s.token_hash=$1 AND a.status='pending_email' AND s.expires_at>now()`,
          [hashToken(token)],
        )
      : undefined;
    if (pending?.rowCount)
      void reply.code(403).send({
        code: 'EMAIL_UNVERIFIED',
        message: 'Verify your email before creating or joining a table.',
      });
    else
      void reply.code(401).send({
        code: 'UNAUTHENTICATED',
        message: 'Sign in required.',
        loginRequired: true,
        ...(code ? { returnTo: `/join/${encodeURIComponent(code)}` } : {}),
      });
    return undefined;
  }
  const view = (
    id: string,
    name: string,
    isHost: boolean,
    code?: string,
  ): RoomInfo => ({ id, name, isHost, ...(code ? { code } : {}) }) as RoomInfo;
  const seatProfile = async (accountId: string) => {
    const row = (
      await db.query<{ display_name: string; mature_opt_out: boolean }>(
        'SELECT display_name, mature_opt_out FROM accounts WHERE id=$1',
        [accountId],
      )
    ).rows[0];
    return {
      displayName: row?.display_name ?? accountId,
      matureOptOut: row?.mature_opt_out ?? false,
    };
  };

  for (const base of ['/api/rooms', '/api/sessions']) {
    app.post(base, async (request, reply) => {
      const accountId = await member(request, reply);
      if (!accountId) return reply;
      const parsed = CreateRoomInputSchema.safeParse(request.body);
      if (!parsed.success)
        return reply
          .code(400)
          .send({ code: 'INVALID_INPUT', message: 'Enter a table name.' });
      if (createHits.hit(accountId) > createPerHour)
        return reply.code(429).send({
          code: 'RATE_LIMITED',
          message: 'You are creating tables too quickly. Try again later.',
        });
      const id = randomUUID();
      // ponytail: count+insert is not serialized; concurrent creates can overshoot by a few. Add an advisory lock if that matters.
      const inserted = await db.query(
        `INSERT INTO sessions(id,owner_account_id,name) SELECT $1,$2,$3
          WHERE (SELECT count(*) FROM sessions WHERE owner_account_id=$2 AND status='active') < $4`,
        [id, accountId, parsed.data.name, maxRooms],
      );
      if (!inserted.rowCount)
        return reply.code(409).send({
          code: 'ROOM_LIMIT',
          message: `You can have at most ${maxRooms} active tables. Close one before creating another.`,
        });
      try {
        const profile = await seatProfile(accountId);
        await (
          await rooms.get(id)
        ).seat(accountId, profile.displayName, profile.matureOptOut);
      } catch (error) {
        await db.query('DELETE FROM sessions WHERE id=$1', [id]);
        throw error;
      }
      const code = await setInvite(db, id, accountId);
      return reply
        .code(201)
        .send({ room: view(id, parsed.data.name, true, code) });
    });
    app.get(base, async (request, reply) => {
      const accountId = await member(request, reply);
      if (!accountId) return reply;
      const r = await db.query<{ id: string; name: string; is_host: boolean }>(
        `${ROOM_LIST_SQL} ORDER BY s.created_at DESC`,
        [accountId],
      );
      return { rooms: r.rows.map((x) => view(x.id, x.name, x.is_host)) };
    });
    app.get(`${base}/:id`, async (request, reply) => {
      const accountId = await member(request, reply);
      if (!accountId) return reply;
      const { id } = request.params as { id: string };
      const r = UUID.test(id)
        ? await db.query<{ id: string; name: string; is_host: boolean }>(
            `${ROOM_LIST_SQL} AND s.id=$2`,
            [accountId, id],
          )
        : undefined;
      const row = r?.rows[0];
      if (!row)
        return reply
          .code(404)
          .send({ code: 'NOT_FOUND', message: 'Not found.' });
      return { room: view(row.id, row.name, row.is_host) };
    });
    // Owner-only: create or regenerate (POST) / revoke (DELETE). Regenerating invalidates the old code.
    for (const method of ['POST', 'DELETE'] as const)
      app.route({
        method,
        url: `${base}/:id/invite`,
        handler: async (request, reply) => {
          const accountId = await member(request, reply);
          if (!accountId) return reply;
          const { id } = request.params as { id: string };
          const room = UUID.test(id)
            ? (
                await db.query<{ name: string; owner: string }>(
                  `SELECT name,owner_account_id AS owner FROM sessions WHERE id=$1 AND status='active'`,
                  [id],
                )
              ).rows[0]
            : undefined;
          const seated = room
            ? room.owner === accountId ||
              (await db.query(`${ROOM_LIST_SQL} AND s.id=$2`, [accountId, id]))
                .rowCount
            : 0;
          if (!room || !seated)
            return reply
              .code(404)
              .send({ code: 'NOT_FOUND', message: 'Not found.' });
          if (room.owner !== accountId)
            return reply.code(403).send({
              code: 'FORBIDDEN',
              message: 'Only the host can do that.',
            });
          if (method === 'DELETE') {
            await revokeInvite(db, id, accountId);
            return { room: view(id, room.name, true) };
          }
          return {
            room: view(id, room.name, true, await setInvite(db, id, accountId)),
          };
        },
      });
  }

  const join = async (
    request: FastifyRequest<{ Params: { code: string } }>,
    reply: import('fastify').FastifyReply,
  ) => {
    const accountId = await member(request, reply);
    if (!accountId) return reply;
    const { code } = request.params;
    if (throttled(`${request.ip}:${code}`))
      return reply.code(429).send({
        code: 'RATE_LIMITED',
        message: 'Too many attempts. Wait a minute.',
      });
    const found = await sessionForCode(db, code);
    if (
      !found ||
      (found.status === 'archived' &&
        !(await restoreForMember(db, found.id, accountId)))
    )
      return reply.code(404).send({
        code: 'INVITE_INVALID',
        message: 'This invite link is no longer valid.',
      });
    const optOut = (request.body as { matureOptOut?: unknown } | null)
      ?.matureOptOut;
    if (typeof optOut === 'boolean')
      await db.query('UPDATE accounts SET mature_opt_out=$2 WHERE id=$1', [
        accountId,
        optOut,
      ]);
    try {
      const profile = await seatProfile(accountId);
      await (
        await rooms.get(found.id)
      ).seat(accountId, profile.displayName, profile.matureOptOut);
    } catch (error) {
      if (error instanceof Error && error.message === 'Room is full')
        return reply
          .code(409)
          .send({ code: 'ROOM_FULL', message: 'This table is full.' });
      throw error;
    }
    return { room: view(found.id, found.name, found.owner === accountId) };
  };
  app.post<{ Params: { code: string } }>('/api/invites/:code/join', join);
  app.post<{ Params: { code: string } }>('/api/join/:code', join);
}
