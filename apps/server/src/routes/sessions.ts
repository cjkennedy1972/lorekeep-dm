import { randomUUID } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import type { registerAuthRoutes } from './auth.js';
import type { Pool } from 'pg';
import {
  CreateRoomInputSchema,
  CancelLateJoinRequestSchema,
  LateJoinHttpRequestSchema,
  type RoomInfo,
} from '@game/schema';
import { authenticateRequest } from '../middleware/auth.js';
import { tokenFromCookie } from '../accounts/sessions.js';
import { hashToken } from '../accounts/signup.js';
import { currentMemberSql } from '../room/membership.js';
import {
  restoreForMember,
  revokeInvite,
  sessionForCode,
  setInvite,
} from '../rooms/invites.js';
import type { RoomRegistry } from '../room/registry.js';
import { BoundedCounter } from '../accounts/throttle.js';
import { loadContentTierState } from '../safety/tierLoader.js';
import { loadCatalog } from '@game/rules-engine/catalog-node';
import { SeatCharacterError } from '../persistence/seatCharacters.js';
import {
  LateJoinLimitedError,
  LateJoinRequestConflictError,
  LateJoinUnavailableError,
} from '../room/Room.js';

type Seater = Pick<RoomRegistry, 'get' | 'getByLateJoinRequestId'>;
const JOIN_LIMIT = 10;
export const MAX_ACTIVE_ROOMS = 20;
export const CREATE_PER_HOUR = 10;
export const ROOM_LIST_SQL = `SELECT s.id,s.name,s.owner_account_id=$1 AS is_host,s.host_tier_cap AS tier_cap FROM sessions s
  WHERE s.status='active' AND (s.owner_account_id=$1 OR ${currentMemberSql('$1')})`;
const catalog = loadCatalog();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createLateJoinRateLimiter() {
  const hits = new Map<string, number[]>();
  return (
    accountId: string,
    ip: string,
    inviteCode: string,
    now = Date.now(),
  ): number | undefined => {
    const keys = [
      [`account:${accountId}`, 10 * 60_000, 3, 2 * 60_000],
      [`ip:${ip}`, 10 * 60_000, 10, 0],
      [`invite:${inviteCode}`, 10 * 60_000, 5, 0],
    ] as const;
    const live = keys.map(([key, windowMs, limit, interval]) => {
      const prior = (hits.get(key) ?? []).filter((at) => now - at < windowMs);
      // ADR-035: count every well-formed authenticated attempt; after the burst, allow one per 2 minutes.
      const rejected = key.startsWith('account:')
        ? prior.length >= limit && now - (prior.at(-1) ?? now) < interval
        : prior.length >= limit;
      const retryMs = rejected
        ? key.startsWith('account:')
          ? interval - (now - (prior.at(-1) ?? now))
          : windowMs - (now - (prior[0] ?? now))
        : 0;
      return { key, prior, rejected, retryMs };
    });
    const blocked = live.find((item) => item.rejected);
    if (blocked) return Math.max(1, Math.ceil(blocked.retryMs / 1000));
    for (const item of live) hits.set(item.key, [...item.prior, now]);
    if (hits.size > 10_000) {
      for (const [key, timestamps] of hits)
        if (!timestamps.length || now - timestamps.at(-1)! > 10 * 60_000)
          hits.delete(key);
    }
    return undefined;
  };
}

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
  const consumeLateJoinLimit = createLateJoinRateLimiter();
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
    tierCap?: 'family' | 'standard' | null,
  ): RoomInfo =>
    ({
      id,
      name,
      isHost,
      ...(code ? { code } : {}),
      ...(tierCap !== undefined ? { tierCap } : {}),
    }) as RoomInfo;
  const onboardingSettings = async (
    sessionId: string,
    accountId: string,
    optedOut: boolean,
  ) => {
    const [session, tierState, personal] = await Promise.all([
      db.query<{
        content_tier: 'family' | 'standard' | 'mature';
        host_tier_cap: 'family' | 'standard' | null;
      }>('SELECT content_tier, host_tier_cap FROM sessions WHERE id=$1', [
        sessionId,
      ]),
      loadContentTierState(db, sessionId, false),
      db.query<{
        content_lines: string[];
        content_veils: string[];
      }>('SELECT content_lines, content_veils FROM accounts WHERE id=$1', [
        accountId,
      ]),
    ]);
    const sessionSettings = session.rows[0];
    if (!sessionSettings) throw new Error('Table settings unavailable');
    const tier =
      optedOut && tierState.tier === 'mature' ? 'standard' : tierState.tier;
    return {
      contentTier: tier,
      hostTierCap: sessionSettings.host_tier_cap,
      matureOptOut: optedOut,
      lines: personal.rows[0]?.content_lines ?? [],
      veils: personal.rows[0]?.content_veils ?? [],
    };
  };
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
      const authToken = tokenFromCookie(request.headers.cookie);
      const authTokenHash = authToken ? hashToken(authToken) : undefined;
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
      const decision = await app.inputGate.check({
        text: parsed.data.name,
        surface: 'room-name',
        accountId,
        ip: request.ip,
      });
      if (decision === 'limited')
        return reply.code(429).send({
          code: 'RATE_LIMITED',
          message: 'Too many requests. Try again later.',
        });
      if (decision === 'block')
        return reply.code(400).send({
          code: 'CONTENT_REJECTED',
          message: 'That table name cannot be used.',
        });
      const id = randomUUID();
      await db.query(
        `INSERT INTO catalog_snapshots(catalog_version,entries)
         VALUES($1,$2::jsonb) ON CONFLICT (catalog_version) DO NOTHING`,
        [catalog.catalogVersion, JSON.stringify(catalog.entries)],
      );
      // ponytail: count+insert is not serialized; concurrent creates can overshoot by a few. Add an advisory lock if that matters.
      const inserted = await db.query(
        `INSERT INTO sessions(id,owner_account_id,name,catalog_version) SELECT $1,$2,$3,$5
          WHERE (SELECT count(*) FROM sessions WHERE owner_account_id=$2 AND status='active') < $4`,
        [id, accountId, parsed.data.name, maxRooms, catalog.catalogVersion],
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
        ).seat(
          accountId,
          profile.displayName,
          profile.matureOptOut,
          authTokenHash,
        );
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
      const r = await db.query<{
        id: string;
        name: string;
        is_host: boolean;
        tier_cap: 'family' | 'standard' | null;
      }>(`${ROOM_LIST_SQL} ORDER BY s.created_at DESC`, [accountId]);
      return {
        rooms: r.rows.map((x) =>
          view(x.id, x.name, x.is_host, undefined, x.tier_cap),
        ),
      };
    });
    app.get(`${base}/:id`, async (request, reply) => {
      const accountId = await member(request, reply);
      if (!accountId) return reply;
      const { id } = request.params as { id: string };
      const r = UUID.test(id)
        ? await db.query<{
            id: string;
            name: string;
            is_host: boolean;
            host_tier_cap: 'family' | 'standard' | null;
          }>(
            `SELECT s.id,s.name,s.owner_account_id=$1 AS is_host,s.host_tier_cap FROM sessions s
             WHERE s.status='active' AND s.id=$2 AND (s.owner_account_id=$1 OR ${currentMemberSql('$1')})`,
            [accountId, id],
          )
        : undefined;
      const row = r?.rows[0];
      if (!row)
        return reply
          .code(404)
          .send({ code: 'NOT_FOUND', message: 'Not found.' });
      return {
        room: view(row.id, row.name, row.is_host, undefined, row.host_tier_cap),
      };
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

  app.post('/api/rooms/:id/leave', async (request, reply) => {
    const accountId = await member(request, reply);
    if (!accountId) return reply;
    const { id } = request.params as { id: string };
    const seated = UUID.test(id)
      ? (await db.query(`${ROOM_LIST_SQL} AND s.id=$2`, [accountId, id]))
          .rowCount
      : 0;
    if (!seated)
      return reply.code(404).send({ code: 'NOT_FOUND', message: 'Not found.' });
    const owner = (
      await db.query<{ owner: string }>(
        `SELECT owner_account_id AS owner FROM sessions WHERE id=$1`,
        [id],
      )
    ).rows[0]?.owner;
    if (owner === accountId)
      return reply.code(403).send({
        code: 'FORBIDDEN',
        message: 'The host cannot leave their own table.',
      });
    await (await rooms.get(id)).leave(accountId);
    return { ok: true };
  });

  const join = async (
    request: FastifyRequest<{ Params: { code: string } }>,
    reply: import('fastify').FastifyReply,
  ) => {
    const accountId = await member(request, reply);
    if (!accountId) return reply;
    const authToken = tokenFromCookie(request.headers.cookie);
    const authTokenHash = authToken ? hashToken(authToken) : undefined;
    const { code } = request.params;
    const found = await sessionForCode(db, code);
    // Preserve the invite-code oracle throttle for repeated invalid codes.
    if (!found && throttled(`${request.ip}:${code}`))
      return reply.code(429).send({
        code: 'RATE_LIMITED',
        message: 'Too many attempts. Wait a minute.',
      });
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
    const profile = await seatProfile(accountId);
    const matureOptOut =
      typeof optOut === 'boolean' ? optOut : profile.matureOptOut;
    let room: import('../room/Room.js').Room;
    try {
      room = await rooms.get(found.id);
      if (
        !room.state?.seats?.some((seat) => seat.accountId === accountId) &&
        room.state?.gameState
      ) {
        const selection = LateJoinHttpRequestSchema.safeParse(request.body);
        if (!selection.success)
          return reply.code(400).send({
            code: 'INVALID_LATE_JOIN_REQUEST',
            message: 'Choose a valid character before requesting to join.',
          });
        const retryAfter = consumeLateJoinLimit(accountId, request.ip, code);
        if (retryAfter)
          return reply
            .header('Retry-After', String(retryAfter))
            .code(429)
            .send({ code: 'request_limited', message: 'Request limited.' });
        const requestId = await room.requestLateJoin(
          accountId,
          selection.data.characterId,
          selection.data.expectedRevision,
          selection.data.actionId,
          profile.displayName,
          matureOptOut,
          authTokenHash,
        );
        if (typeof optOut === 'boolean')
          await db.query('UPDATE accounts SET mature_opt_out=$2 WHERE id=$1', [
            accountId,
            optOut,
          ]);
        const settings = await onboardingSettings(
          found.id,
          accountId,
          matureOptOut,
        );
        return reply.code(409).send({
          settings,
          code: 'LATE_JOIN_PENDING',
          message:
            'Your request is waiting for the host. Retry this invite after it is approved.',
          requestId,
        });
      }
      if (throttled(`${request.ip}:${code}`))
        return reply.code(429).send({
          code: 'RATE_LIMITED',
          message: 'Too many attempts. Wait a minute.',
        });
      await room.seat(
        accountId,
        profile.displayName,
        matureOptOut,
        authTokenHash,
      );
    } catch (error) {
      if (error instanceof LateJoinUnavailableError)
        return reply.code(404).send({
          code: 'INVITE_INVALID',
          message: 'This invite link is no longer valid.',
        });
      if (error instanceof LateJoinLimitedError)
        return (
          error.retryAfterSeconds !== undefined
            ? reply.header('Retry-After', String(error.retryAfterSeconds))
            : reply
        )
          .code(429)
          .send({ code: 'request_limited', message: 'Request limited.' });
      if (error instanceof LateJoinRequestConflictError)
        return reply.code(409).send({
          code: 'LATE_JOIN_REQUEST_CONFLICT',
          message: 'Late-join request conflicts with an existing request.',
        });
      if (error instanceof SeatCharacterError)
        return error.code === 'NOT_FOUND'
          ? reply.code(404).send({
              code: 'CHARACTER_UNAVAILABLE',
              message: 'Character could not be selected.',
            })
          : reply.code(error.code === 'STALE_REVISION' ? 409 : 400).send({
              code:
                error.code === 'STALE_REVISION'
                  ? 'CHARACTER_CHANGED'
                  : 'INVALID_CHARACTER',
              message: 'Character could not be selected.',
            });
      if (error instanceof Error && error.message === 'Room is full')
        return reply
          .code(409)
          .send({ code: 'ROOM_FULL', message: 'This table is full.' });
      throw error;
    }
    if (typeof optOut === 'boolean')
      await db.query('UPDATE accounts SET mature_opt_out=$2 WHERE id=$1', [
        accountId,
        optOut,
      ]);
    return {
      room: view(found.id, found.name, found.owner === accountId),
    };
  };
  app.get<{ Params: { code: string } }>(
    '/api/invites/:code',
    async (request, reply) => {
      const accountId = await member(request, reply);
      if (!accountId) return reply;
      const { code } = request.params;
      if (throttled(`${request.ip}:${code}`))
        return reply.code(429).send({
          code: 'RATE_LIMITED',
          message: 'Too many attempts. Wait a minute.',
        });
      const found = await sessionForCode(db, code);
      if (!found)
        return reply.code(404).send({
          code: 'INVITE_INVALID',
          message: 'This invite link is no longer valid.',
        });
      return {
        room: {
          ...view(
            found.id,
            found.name,
            found.owner === accountId,
            undefined,
            found.hostTierCap,
          ),
        },
      };
    },
  );
  app.post<{ Params: { code: string } }>(
    '/api/invites/:code/late-join',
    async (request, reply) => {
      const accountId = await member(request, reply);
      if (!accountId) return reply;
      const authToken = tokenFromCookie(request.headers.cookie);
      const authTokenHash = authToken ? hashToken(authToken) : undefined;
      const found = await sessionForCode(db, request.params.code);
      if (!found || found.status !== 'active')
        return reply.code(404).send({
          code: 'INVITE_INVALID',
          message: 'This invite link is no longer valid.',
        });
      const profile = await seatProfile(accountId);
      const selection = LateJoinHttpRequestSchema.safeParse(request.body);
      if (!selection.success)
        return reply.code(400).send({
          code: 'INVALID_LATE_JOIN_REQUEST',
          message: 'Choose a valid character before requesting to join.',
        });
      const retryAfter = consumeLateJoinLimit(
        accountId,
        request.ip,
        request.params.code,
      );
      if (retryAfter)
        return reply
          .header('Retry-After', String(retryAfter))
          .code(429)
          .send({ code: 'request_limited', message: 'Request limited.' });
      const optOut = selection.data.matureOptOut;
      try {
        const requestId = await (
          await rooms.get(found.id)
        ).requestLateJoin(
          accountId,
          selection.data.characterId,
          selection.data.expectedRevision,
          selection.data.actionId,
          profile.displayName,
          typeof optOut === 'boolean' ? optOut : profile.matureOptOut,
          authTokenHash,
        );
        if (typeof optOut === 'boolean')
          await db.query('UPDATE accounts SET mature_opt_out=$2 WHERE id=$1', [
            accountId,
            optOut,
          ]);
        const settings = await onboardingSettings(
          found.id,
          accountId,
          typeof optOut === 'boolean' ? optOut : profile.matureOptOut,
        );
        return reply.code(202).send({
          settings,
          requestId,
          status: 'pending',
        });
      } catch (error) {
        if (error instanceof LateJoinUnavailableError)
          return reply.code(404).send({
            code: 'INVITE_INVALID',
            message: 'This invite link is no longer valid.',
          });
        if (error instanceof LateJoinLimitedError)
          return (
            error.retryAfterSeconds !== undefined
              ? reply.header('Retry-After', String(error.retryAfterSeconds))
              : reply
          )
            .code(429)
            .send({ code: 'request_limited', message: 'Request limited.' });
        if (error instanceof LateJoinRequestConflictError)
          return reply.code(409).send({
            code: 'LATE_JOIN_REQUEST_CONFLICT',
            message: 'Late-join request conflicts with an existing request.',
          });
        if (error instanceof SeatCharacterError)
          return error.code === 'NOT_FOUND'
            ? reply.code(404).send({
                code: 'CHARACTER_UNAVAILABLE',
                message: 'Character could not be selected.',
              })
            : reply.code(error.code === 'STALE_REVISION' ? 409 : 400).send({
                code:
                  error.code === 'STALE_REVISION'
                    ? 'CHARACTER_CHANGED'
                    : 'INVALID_CHARACTER',
                message: 'Character could not be selected.',
              });
        if (error instanceof Error && error.message === 'Room is full')
          return reply
            .code(409)
            .send({ code: 'ROOM_FULL', message: 'This table is full.' });
        if (error instanceof Error && error.message === 'Already seated')
          return reply.code(409).send({
            code: 'ALREADY_SEATED',
            message: 'You already have a seat at this table.',
          });
        if (
          error instanceof Error &&
          error.message === 'Join request already pending'
        )
          return reply.code(409).send({
            code: 'JOIN_PENDING',
            message: 'Your request is already pending.',
          });
        throw error;
      }
    },
  );
  app.post<{ Params: { code: string } }>('/api/invites/:code/join', join);
  app.post<{ Params: { code: string } }>('/api/join/:code', join);
  app.post<{ Params: { requestId: string } }>(
    '/api/late-join/:requestId/cancel',
    async (request, reply) => {
      const accountId = await member(request, reply);
      if (!accountId) return reply;
      const parsed = CancelLateJoinRequestSchema.safeParse(request.body);
      if (!parsed.success || parsed.data.requestId !== request.params.requestId)
        return reply.code(400).send({
          code: 'INVALID_LATE_JOIN_REQUEST',
          message: 'Late-join cancellation is invalid.',
        });
      try {
        const room = await rooms.getByLateJoinRequestId(
          request.params.requestId,
        );
        if (!room)
          return reply
            .code(404)
            .send({ code: 'NOT_FOUND', message: 'Not found.' });
        await room.cancelLateJoin(
          accountId,
          parsed.data.actionId,
          parsed.data.requestId,
        );
        return { ok: true };
      } catch {
        return reply
          .code(404)
          .send({ code: 'NOT_FOUND', message: 'Not found.' });
      }
    },
  );
}
