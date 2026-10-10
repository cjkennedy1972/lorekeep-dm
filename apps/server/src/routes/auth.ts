import type { FastifyInstance } from 'fastify';
import type { Server } from 'node:http';
import type { Logger } from 'pino';
import type { Pool } from 'pg';
import type { EmailSender } from '../email/sender.js';
import { signup, signupSchema } from '../accounts/signup.js';
import { verifyEmail } from '../accounts/verify.js';
import { login, badCredentials } from '../accounts/login.js';
import { BoundedCounter, BusyError } from '../accounts/throttle.js';
import type { ConnectionRegistry } from '../gateway/connections.js';
import {
  clearSessionCookie,
  deviceLabel,
  revokeSession,
  secureCookies,
  sessionCookie,
  tokenFromCookie,
} from '../accounts/sessions.js';
import { authenticateRequest } from '../middleware/auth.js';
import { validOrigin } from '../middleware/origin.js';
import {
  LoginInputSchema,
  ChangePasswordInputSchema,
  DeleteAccountInputSchema,
} from '@game/schema';
import { z } from 'zod';
import {
  requestPasswordReset,
  confirmPasswordReset,
  changePassword,
} from '../accounts/reset.js';
import {
  verifyPassword,
  hashPassword,
  validPassword,
} from '../accounts/password.js';
import {
  createExport,
  latestExport,
  exportStatus,
  validExportSignature,
} from '../accounts/export.js';
import { requestDeletion } from '../accounts/delete.js';
import { LocalObjectStore } from '../storage/objectStore.js';

export function registerAuthRoutes(
  app: FastifyInstance<
    Server,
    import('node:http').IncomingMessage,
    import('node:http').ServerResponse,
    Logger
  >,
  db: Pool,
  sender: EmailSender,
  cookieSecret: string,
  rateLimit = 5,
  connections?: Pick<ConnectionRegistry, 'sweep'>,
) {
  /** Close sockets whose auth session/account is gone; call after any revocation. */
  const closeRevoked = () => connections?.sweep().catch(() => {});
  const store = new LocalObjectStore();
  const exportHits = new Map<string, number>();
  const hits = new Map<string, { count: number; reset: number }>();
  function limited(key: string): boolean {
    const now = Date.now();
    const item = hits.get(key);
    if (!item || item.reset <= now) {
      hits.set(key, { count: 1, reset: now + 60_000 });
      return false;
    }
    item.count++;
    return item.count > rateLimit;
  }
  // Failed-login limiters (bounded, TTL-evicted): per IP+email and per IP across emails.
  const emailFailures = new BoundedCounter(600_000);
  const ipFailures = new BoundedCounter(600_000);
  const EMAIL_FAIL_LIMIT = 5;
  const IP_FAIL_LIMIT = 20;
  const EXPORTS_PER_WEEK = 10;
  app.addHook('onRequest', async (request, reply) => {
    if (!validOrigin(request))
      return reply
        .code(403)
        .send({ code: 'BAD_ORIGIN', message: 'Origin not allowed.' });
  });
  const forgotSchema = z.object({ email: z.email() }).strict();
  const resetSchema = z
    .object({ token: z.string(), password: z.string() })
    .strict();
  const forgot = async (
    request: { body: unknown; ip: string },
    reply: { code: (status: number) => { send: (body: unknown) => unknown } },
  ) => {
    const parsed = forgotSchema.safeParse(request.body);
    if (!parsed.success)
      return reply
        .code(400)
        .send({ code: 'INVALID_INPUT', message: 'Invalid email.' });
    const email = parsed.data.email.trim().toLowerCase();
    const throttled =
      limited(`forgot-ip:${request.ip}`) || limited(`forgot-email:${email}`);
    if (!throttled) await requestPasswordReset(db, sender, email);
    return reply.code(202).send({});
  };
  app.post('/api/password/forgot', forgot);
  app.post('/api/password-reset/request', forgot);
  const reset = async (
    request: { body: unknown; ip: string },
    reply: { code: (status: number) => { send: (body: unknown) => unknown } },
  ) => {
    const parsed = resetSchema.safeParse(request.body);
    if (!parsed.success || !validPassword(parsed.data.password))
      return reply.code(400).send({
        code: 'INVALID_INPUT',
        message: 'Password must be at least 12 characters.',
      });
    if (
      limited(`reset-ip:${request.ip}`) ||
      limited(`reset-token:${request.ip}:${parsed.data.token}`)
    )
      return reply
        .code(429)
        .send({ code: 'RATE_LIMITED', message: 'Too many requests.' });
    const ok = await confirmPasswordReset(
      db,
      parsed.data.token,
      parsed.data.password,
    );
    if (ok) await closeRevoked();
    return reply.code(ok ? 200 : 400).send(
      ok
        ? {}
        : {
            code: 'TOKEN_INVALID',
            message: 'This link is invalid or has expired.',
          },
    );
  };
  app.post('/api/password/reset', reset);
  app.post('/api/password-reset/confirm', reset);
  app.post('/api/login', async (request, reply) => {
    const parsed = LoginInputSchema.safeParse(request.body);
    if (!parsed.success)
      return reply
        .code(400)
        .send({ code: 'INVALID_INPUT', message: 'Invalid login details.' });
    const email = parsed.data.email.trim().toLowerCase();
    const key = `${request.ip}:${email}`;
    // Throttle first so blocked requests never reach argon2.
    if (
      emailFailures.count(key) >= EMAIL_FAIL_LIMIT ||
      ipFailures.count(request.ip) >= IP_FAIL_LIMIT
    )
      return reply.code(429).send(badCredentials);
    let result;
    try {
      result = await login(
        db,
        email,
        parsed.data.password,
        deviceLabel(request.headers['user-agent'] ?? ''),
      );
    } catch (error) {
      if (error instanceof BusyError)
        return reply.code(503).header('retry-after', '2').send({
          code: 'BUSY',
          message: 'Server is busy. Try again shortly.',
        });
      throw error;
    }
    if (result.kind === 'invalid') {
      emailFailures.hit(key);
      ipFailures.hit(request.ip);
      return reply.code(401).send(badCredentials);
    }
    if (result.kind === 'deleting')
      return reply.code(403).send({
        code: 'ACCOUNT_DELETING',
        message: 'This account is being deleted and cannot be signed in.',
      });
    if (result.kind === 'pending')
      return reply.code(403).send({
        code: 'EMAIL_UNVERIFIED',
        message: 'Check your email and verify your account before signing in.',
      });
    emailFailures.clear(key);
    reply.header('set-cookie', sessionCookie(result.token, secureCookies()));
    const a = result.account;
    return {
      account: {
        id: a.id,
        email: a.email,
        displayName: a.display_name,
        isAdult: a.is_adult,
        ageCheckedAt: new Date(a.age_checked_at).toISOString(),
      },
    };
  });
  app.post('/api/logout', async (request, reply) => {
    const token = tokenFromCookie(request.headers.cookie);
    if (token) {
      await revokeSession(db, token);
      await closeRevoked();
    }
    reply.header('set-cookie', clearSessionCookie(secureCookies()));
    return {};
  });
  const authed = async (
    request: Parameters<typeof authenticateRequest>[1],
    reply: { code: (status: number) => { send: (body: unknown) => unknown } },
  ) => {
    const session = await authenticateRequest(db, request);
    if (!session) {
      reply
        .code(401)
        .send({ code: 'UNAUTHENTICATED', message: 'Sign in required.' });
      return undefined;
    }
    return session;
  };
  app.get('/api/me', async (request, reply) => {
    const session = await authed(request, reply);
    if (!session) return reply;
    const result = await db.query(
      'SELECT id,email,display_name,is_adult,age_checked_at FROM accounts WHERE id=$1',
      [session.account_id],
    );
    const a = result.rows[0];
    return {
      account: {
        id: a.id,
        email: a.email,
        displayName: a.display_name,
        isAdult: a.is_adult,
        ageCheckedAt: new Date(a.age_checked_at).toISOString(),
      },
    };
  });
  app.patch('/api/me', async (request, reply) => {
    const session = await authed(request, reply);
    if (!session) return reply;
    const name = (request.body as { displayName?: unknown } | null)
      ?.displayName;
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 80)
      return reply
        .code(400)
        .send({ code: 'INVALID_INPUT', message: 'Enter a display name.' });
    const a = (
      await db.query(
        'UPDATE accounts SET display_name=$2 WHERE id=$1 RETURNING id,email,display_name,is_adult,age_checked_at',
        [session.account_id, name.trim()],
      )
    ).rows[0];
    return {
      account: {
        id: a.id,
        email: a.email,
        displayName: a.display_name,
        isAdult: a.is_adult,
        ageCheckedAt: new Date(a.age_checked_at).toISOString(),
      },
    };
  });
  app.post('/api/me/password', async (request, reply) => {
    const session = await authed(request, reply);
    if (!session) return reply;
    const parsed = ChangePasswordInputSchema.safeParse(request.body);
    if (!parsed.success || !validPassword(parsed.data.newPassword))
      return reply.code(400).send({
        code: 'INVALID_INPUT',
        message: 'New password must be at least 12 characters.',
      });
    const row = (
      await db.query('SELECT password_hash FROM accounts WHERE id=$1', [
        session.account_id,
      ])
    ).rows[0];
    if (
      !row ||
      !(await verifyPassword(row.password_hash, parsed.data.currentPassword))
    )
      return reply.code(403).send({
        code: 'BAD_CREDENTIALS',
        message: 'Current password is incorrect.',
      });
    await changePassword(
      db,
      session.account_id,
      session.token_hash,
      await hashPassword(parsed.data.newPassword),
    );
    await closeRevoked();
    return {};
  });
  app.post('/api/me/export', async (request, reply) => {
    const session = await authed(request, reply);
    if (!session) return reply;
    const previous = exportHits.get(session.account_id) ?? 0;
    if (Date.now() - previous < 60_000)
      return reply.code(429).send({
        code: 'RATE_LIMITED',
        message: 'Please wait before requesting another export.',
      });
    const body = request.body as { password?: unknown } | null;
    const throttleKey = `export:${session.account_id}`;
    // Throttle first so guesses never reach argon2; per account across IPs, and per IP.
    if (
      emailFailures.count(throttleKey) >= EMAIL_FAIL_LIMIT ||
      ipFailures.count(request.ip) >= IP_FAIL_LIMIT
    )
      return reply.code(429).send({
        code: 'RATE_LIMITED',
        message: 'Too many password attempts. Try again later.',
      });
    {
      const row = (
        await db.query('SELECT password_hash FROM accounts WHERE id=$1', [
          session.account_id,
        ])
      ).rows[0];
      if (
        typeof body?.password !== 'string' ||
        !row ||
        !(await verifyPassword(row.password_hash, body.password))
      ) {
        emailFailures.hit(throttleKey);
        ipFailures.hit(request.ip);
        return reply
          .code(403)
          .send({ code: 'BAD_CREDENTIALS', message: 'Password is incorrect.' });
      }
    }
    const recent = (
      await db.query(
        "SELECT count(*)::int AS n FROM export_jobs WHERE account_id=$1 AND requested_at > now() - interval '7 days'",
        [session.account_id],
      )
    ).rows[0].n;
    if (recent >= EXPORTS_PER_WEEK)
      return reply.code(429).send({
        code: 'RATE_LIMITED',
        message: 'Export limit reached for this week.',
      });
    exportHits.set(session.account_id, Date.now());
    return reply
      .code(202)
      .send({ job: await createExport(db, session.account_id, store) });
  });
  app.get('/api/me/export-job', async (request, reply) => {
    const session = await authed(request, reply);
    if (!session) return reply;
    return {
      job: exportStatus(
        await latestExport(db, session.account_id),
        cookieSecret,
      ),
    };
  });
  app.get('/api/me/export', async (request, reply) => {
    const session = await authed(request, reply);
    if (!session) return reply;
    const query = request.query as {
      id?: string;
      expires?: string;
      sig?: string;
    };
    const row = await latestExport(db, session.account_id);
    if (
      !row ||
      row.id !== query.id ||
      !query.expires ||
      !query.sig ||
      row.status !== 'completed' ||
      new Date(row.expires_at).toISOString() !== query.expires ||
      !validExportSignature(row.id, query.expires, query.sig, cookieSecret)
    )
      return reply
        .code(404)
        .send({ code: 'NOT_FOUND', message: 'No export is ready.' });
    try {
      const archive = await store.get(row.archive_key);
      reply.header('content-type', 'application/json; charset=utf-8');
      reply.header(
        'content-disposition',
        'attachment; filename="lorekeep-export.json"',
      );
      reply.header('cache-control', 'no-store');
      return archive;
    } catch {
      return reply
        .code(404)
        .send({ code: 'NOT_FOUND', message: 'No export is ready.' });
    }
  });
  app.delete('/api/me', async (request, reply) => {
    const session = await authed(request, reply);
    if (!session) return reply;
    const parsed = DeleteAccountInputSchema.safeParse(request.body);
    if (!parsed.success)
      return reply.code(400).send({
        code: 'INVALID_INPUT',
        message: 'Type the confirmation phrase exactly.',
      });
    if (!(await requestDeletion(db, session.account_id, parsed.data.password)))
      return reply
        .code(403)
        .send({ code: 'BAD_CREDENTIALS', message: 'Password is incorrect.' });
    await closeRevoked();
    reply.header('set-cookie', clearSessionCookie(secureCookies()));
    return {
      message:
        'Account deletion requested. This cannot be undone. Personal data will be purged within 30 days.',
    };
  });
  app.get('/api/me/sessions', async (request, reply) => {
    const session = await authed(request, reply);
    if (!session) return reply;
    const rows = await db.query(
      'SELECT token_hash,ua_label,last_active_at FROM auth_sessions WHERE account_id=$1 AND expires_at>now() AND absolute_expires_at>now() ORDER BY last_active_at DESC',
      [session.account_id],
    );
    return {
      sessions: rows.rows.map((s) => ({
        id: s.token_hash,
        label: s.ua_label ?? 'Unknown device',
        lastActiveAt: new Date(s.last_active_at).toISOString(),
        current: s.token_hash === session.token_hash,
      })),
    };
  });
  app.delete('/api/me/sessions/:id', async (request, reply) => {
    const session = await authed(request, reply);
    if (!session) return reply;
    const { id } = request.params as { id: string };
    const result = await db.query(
      'DELETE FROM auth_sessions WHERE token_hash=$1 AND account_id=$2',
      [id, session.account_id],
    );
    if (!result.rowCount)
      return reply.code(404).send({ code: 'NOT_FOUND', message: 'Not found.' });
    await closeRevoked();
    if (id === session.token_hash)
      reply.header('set-cookie', clearSessionCookie(secureCookies()));
    return {};
  });
  app.post('/api/me/sessions/revoke-others', async (request, reply) => {
    const session = await authed(request, reply);
    if (!session) return reply;
    await db.query(
      'DELETE FROM auth_sessions WHERE account_id=$1 AND token_hash<>$2',
      [session.account_id, session.token_hash],
    );
    await closeRevoked();
    return {};
  });
  app.post('/api/signup', async (request, reply) => {
    const parsed = signupSchema.safeParse(request.body);
    if (!parsed.success)
      return reply.code(400).send({ message: 'Invalid signup details' });
    const email = parsed.data.email.trim().toLowerCase();
    if (limited(`ip:${request.ip}`) || limited(`email:${email}`))
      return reply.code(429).send({ message: 'Too many requests' });
    try {
      const result = await signup(db, sender, parsed.data, {
        cookieSecret,
        cookie: request.headers.cookie,
      });
      if (result.retryBlockCookie)
        reply.header('set-cookie', result.retryBlockCookie);
      return reply.code(result.refused ? 403 : 202).send(result.response);
    } catch (error) {
      if (error instanceof RangeError)
        return reply.code(400).send({ message: 'Invalid signup details' });
      throw error;
    }
  });
  app.post('/api/verify-email', async (request, reply) => {
    const body = (request.body ?? {}) as {
      token?: unknown;
      password?: unknown;
    };
    if (typeof body.password !== 'string' || !validPassword(body.password))
      return reply.code(400).send({
        message: 'Use at least 12 characters, and not a common password.',
      });
    const ok =
      typeof body.token === 'string' &&
      (await verifyEmail(db, body.token, body.password));
    return reply.code(ok ? 200 : 400).send({
      message: ok ? 'Email verified' : 'Invalid or expired verification link',
    });
  });
}
