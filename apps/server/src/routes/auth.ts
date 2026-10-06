import type { FastifyInstance } from 'fastify';
import type { Server } from 'node:http';
import type { Logger } from 'pino';
import type { Pool } from 'pg';
import type { EmailSender } from '../email/sender.js';
import { signup, signupSchema } from '../accounts/signup.js';
import { verifyEmail } from '../accounts/verify.js';
import { login, badCredentials } from '../accounts/login.js';
import {
  clearSessionCookie,
  deviceLabel,
  revokeSession,
  sessionCookie,
  tokenFromCookie,
} from '../accounts/sessions.js';
import { authenticateRequest } from '../middleware/auth.js';
import { validOrigin } from '../middleware/origin.js';
import { LoginInputSchema } from '@game/schema';
import { z } from 'zod';
import {
  requestPasswordReset,
  confirmPasswordReset,
} from '../accounts/reset.js';
import { validPassword } from '../accounts/password.js';

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
) {
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
  const failures = new Map<string, { count: number; reset: number }>();
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
    const now = Date.now();
    let attempt = failures.get(key);
    if (!attempt || attempt.reset <= now) {
      attempt = { count: 0, reset: now + 600_000 };
      failures.set(key, attempt);
    }
    // Perform the password verification even when blocked to preserve response timing.
    const result = await login(
      db,
      email,
      parsed.data.password,
      deviceLabel(request.headers['user-agent'] ?? ''),
    );
    if (attempt.count >= 5) {
      if (result.kind === 'ok') await revokeSession(db, result.token);
      return reply.code(429).send(badCredentials);
    }
    if (result.kind === 'invalid') {
      attempt.count++;
      return reply.code(401).send(badCredentials);
    }
    if (result.kind === 'pending')
      return reply.code(403).send({
        code: 'EMAIL_UNVERIFIED',
        message: 'Check your email and verify your account before signing in.',
      });
    failures.delete(key);
    reply.header(
      'set-cookie',
      sessionCookie(result.token, process.env.NODE_ENV === 'production'),
    );
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
    if (token) await revokeSession(db, token);
    reply.header(
      'set-cookie',
      clearSessionCookie(process.env.NODE_ENV === 'production'),
    );
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
    if (id === session.token_hash)
      reply.header(
        'set-cookie',
        clearSessionCookie(process.env.NODE_ENV === 'production'),
      );
    return {};
  });
  app.post('/api/me/sessions/revoke-others', async (request, reply) => {
    const session = await authed(request, reply);
    if (!session) return reply;
    await db.query(
      'DELETE FROM auth_sessions WHERE account_id=$1 AND token_hash<>$2',
      [session.account_id, session.token_hash],
    );
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
  const verify = async (
    request: { query?: unknown; body?: unknown },
    reply: { code: (status: number) => { send: (body: unknown) => unknown } },
  ) => {
    const source = request.body ?? request.query;
    const token =
      typeof source === 'object' && source !== null && 'token' in source
        ? source.token
        : undefined;
    const ok = typeof token === 'string' && (await verifyEmail(db, token));
    return reply.code(ok ? 200 : 400).send({
      message: ok ? 'Email verified' : 'Invalid or expired verification link',
    });
  };
  app.get('/api/verify-email', verify);
  app.post('/api/verify-email', verify);
}
