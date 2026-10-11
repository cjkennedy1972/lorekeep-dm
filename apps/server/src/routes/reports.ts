import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { BoundedCounter } from '../accounts/throttle.js';
import { authenticateRequest } from '../middleware/auth.js';
import { validOrigin } from '../middleware/origin.js';
import type { registerAuthRoutes } from './auth.js';
import { ROOM_LIST_SQL } from './sessions.js';

export const REPORT_CATEGORIES = [
  'harassment',
  'hate',
  'sexual',
  'threat_or_self_harm',
  'underage',
  'other',
] as const;
export const REPORT_STATUSES = [
  'open',
  'reviewed',
  'dismissed',
  'actioned',
] as const;
export type ReportStatus = (typeof REPORT_STATUSES)[number];
export const REPORT_TRANSITIONS: Record<ReportStatus, readonly ReportStatus[]> =
  {
    open: ['reviewed', 'dismissed', 'actioned'],
    reviewed: ['dismissed', 'actioned', 'open'],
    dismissed: ['open'],
    actioned: ['reviewed'],
  };
const REPORTS_PER_HOUR = 10;
const CONTEXT_BEFORE = 10;
const TEXT_LIMIT = 500;
export const TEXT_KEYS = ['text', 'narrative', 'narration'] as const;
/** Internal author account id on a message entry. Never returned by the API; redacted on account deletion. */
export const AUTHOR_KEY = '_authorId';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const bodySchema = z.object({
  messageRef: z.number().int().positive(),
  category: z.enum(REPORT_CATEGORIES),
  reason: z
    .string()
    .trim()
    .refine((reason) => Array.from(reason).length <= 500)
    .default(''),
});

// TODO: run `reason` through the hard-floor check once safety/hardFloor.ts (PR #153) is on main.

/**
 * Keeps message text only. Player names become seat labels assigned in order of first
 * appearance; the reporter is 'Reporter'. Account ids never leave this function except as
 * AUTHOR_KEY on message entries.
 */
function snapshotOf(
  events: Array<{
    seq: string;
    type: string;
    payload: Record<string, unknown>;
  }>,
  reporterId: string,
) {
  const labels = new Map<string, string>([[reporterId, 'Reporter']]);
  let players = 0;
  const labelOf = (accountId: unknown) => {
    if (typeof accountId !== 'string') return undefined;
    if (!labels.has(accountId)) {
      const n = players++;
      labels.set(
        accountId,
        n < 26 ? `Player ${String.fromCharCode(65 + n)}` : `Player ${n + 1}`,
      );
    }
    return labels.get(accountId);
  };
  // Code points, not UTF-16 units: a cut inside a surrogate pair is invalid jsonb.
  const cut = (value: string) =>
    Array.from(value).slice(0, TEXT_LIMIT).join('');
  return events.map((event) => {
    const out: Record<string, unknown> = {
      seq: Number(event.seq),
      type: event.type,
    };
    const label =
      typeof event.payload.playerName === 'string'
        ? labelOf(event.payload.accountId)
        : undefined;
    if (label) out.playerName = label;
    for (const key of TEXT_KEYS) {
      const value = event.payload[key];
      if (typeof value === 'string') out[key] = cut(value);
    }
    const author = event.payload.accountId;
    if (
      typeof author === 'string' &&
      (label || TEXT_KEYS.some((k) => k in out))
    )
      out[AUTHOR_KEY] = author;
    return out;
  });
}

/**
 * Runs `work` in a transaction holding FOR SHARE on the session row, so a concurrent account
 * deletion (which takes FOR UPDATE on it) either finishes before the reads or waits until this commits.
 */
async function withSessionShareLock<T>(
  db: Pool,
  sessionId: string,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT 1 FROM sessions WHERE id=$1 FOR SHARE', [
      sessionId,
    ]);
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/** Strips internal markers from snapshot entries before they leave the server. */
export function publicContext(context: Array<Record<string, unknown>>) {
  return context.map((entry) =>
    Object.fromEntries(
      Object.entries(entry).filter(([key]) => key !== AUTHOR_KEY),
    ),
  );
}

export function registerReportRoutes(
  app: Parameters<typeof registerAuthRoutes>[0],
  db: Pool,
) {
  const reportHits = new BoundedCounter(3_600_000);
  app.post<{ Params: { id: string } }>(
    '/api/rooms/:id/reports',
    async (request, reply) => {
      if (!validOrigin(request))
        return reply
          .code(403)
          .send({ code: 'BAD_ORIGIN', message: 'Origin not allowed.' });
      const auth = await authenticateRequest(db, request);
      if (!auth)
        return reply
          .code(401)
          .send({ code: 'UNAUTHENTICATED', message: 'Sign in required.' });
      const { id } = request.params;
      const seated =
        UUID.test(id) &&
        (await db.query(`${ROOM_LIST_SQL} AND s.id=$2`, [auth.account_id, id]))
          .rowCount;
      if (!seated)
        return reply
          .code(404)
          .send({ code: 'NOT_FOUND', message: 'Not found.' });
      const parsed = bodySchema.safeParse(request.body);
      if (!parsed.success)
        return reply.code(400).send({
          code: 'INVALID_INPUT',
          message: 'Check the message and the report category.',
        });
      if (reportHits.hit(auth.account_id) > REPORTS_PER_HOUR)
        return reply.code(429).send({
          code: 'RATE_LIMITED',
          message: 'Too many reports. Try again later.',
        });
      const { messageRef, category, reason } = parsed.data;
      const rejected = await withSessionShareLock(db, id, async (client) => {
        const reported = (
          await client.query<{
            seq: string;
            type: string;
            payload: Record<string, unknown>;
          }>(
            'SELECT seq,type,payload FROM events WHERE session_id=$1 AND seq=$2',
            [id, messageRef],
          )
        ).rows[0];
        if (!reported)
          return {
            code: 404,
            body: { code: 'NOT_FOUND', message: 'Not found.' },
          };
        if (
          ![...TEXT_KEYS, 'playerName'].some(
            (key) => typeof reported.payload[key] === 'string',
          )
        )
          return {
            code: 422,
            body: { code: 'NOT_REPORTABLE', message: 'That is not a message.' },
          };
        const author =
          typeof reported.payload.accountId === 'string' &&
          UUID.test(reported.payload.accountId)
            ? reported.payload.accountId
            : null;
        if (author === auth.account_id)
          return {
            code: 422,
            body: {
              code: 'OWN_MESSAGE',
              message: 'You cannot report your own message.',
            },
          };
        const context = (
          await client.query<{
            seq: string;
            type: string;
            payload: Record<string, unknown>;
          }>(
            'SELECT seq,type,payload FROM events WHERE session_id=$1 AND seq<=$2 ORDER BY seq DESC LIMIT $3',
            [id, messageRef, CONTEXT_BEFORE + 1],
          )
        ).rows.reverse();
        await client.query(
          `INSERT INTO message_reports(session_id,message_seq,reporter_account_id,author_account_id,category,reason,context)
           VALUES($1,$2,$3,(SELECT id FROM accounts WHERE id=$4),$5,$6,$7)
           ON CONFLICT (session_id,message_seq,reporter_account_id) DO NOTHING`,
          [
            id,
            messageRef,
            auth.account_id,
            author,
            category,
            reason,
            JSON.stringify(snapshotOf(context, auth.account_id)),
          ],
        );
        return null;
      });
      if (rejected) return reply.code(rejected.code).send(rejected.body);
      return reply.code(202).send({ received: true });
    },
  );
}

export const reportQuerySchema = z.object({
  status: z.enum(REPORT_STATUSES).default('open'),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).max(10_000).default(0),
});

export const reportPatchSchema = z.object({ status: z.enum(REPORT_STATUSES) });
