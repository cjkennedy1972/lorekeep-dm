import type { FastifyInstance } from 'fastify';
import { isIP } from 'node:net';
import { createHash } from 'node:crypto';
import type { IncomingMessage, Server } from 'node:http';
import type { Logger } from 'pino';
import type { Pool } from 'pg';
import { sendBestEffort, type EmailSender } from '../email/sender.js';
import { signup, signupResponse, signupSchema } from '../accounts/signup.js';
import { resendVerification, verifyEmail } from '../accounts/verify.js';
import { login, badCredentials } from '../accounts/login.js';
import {
  BoundedCounter,
  BusyError,
  KeyedConcurrencyGate,
} from '../accounts/throttle.js';
import type { ConnectionRegistry } from '../gateway/connections.js';
import {
  clearSessionCookie,
  deviceLabel,
  revokeSession,
  secureCookies,
  sessionCookie,
  tokenFromCookie,
  getSession,
} from '../accounts/sessions.js';
import { authenticateRequest } from '../middleware/auth.js';
import {
  EmailSchema,
  LoginInputSchema,
  ChangePasswordInputSchema,
  DeleteAccountInputSchema,
} from '@game/schema';
import { z } from 'zod';
import {
  requestPasswordReset,
  requestPasswordResetIfMissing,
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

/** Group IPv4 clients by /24 and IPv6 clients by /64 for the account bucket. */
function networkBucket(ip: string): string {
  const normalized = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
  if (isIP(normalized) === 4)
    return `${normalized.split('.').slice(0, 3).join('.')}.0/24`;
  if (isIP(normalized) === 6) {
    const address = normalized.split('%', 1)[0]!.toLowerCase();
    const [left = '', right = ''] = address.split('::');
    const before = left ? left.split(':') : [];
    const after = right ? right.split(':') : [];
    const expanded = [
      ...before,
      ...Array<string>(8 - before.length - after.length).fill('0'),
      ...after,
    ];
    return `${expanded
      .slice(0, 4)
      .map((part) => part.padStart(4, '0'))
      .join(':')}::/64`;
  }
  return normalized;
}

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
  const exportCooldown = new BoundedCounter(60_000);
  const hits = new BoundedCounter(60_000);
  function limited(key: string): boolean {
    return hits.hit(key) > rateLimit;
  }
  // Login failure buckets are bounded, hashed where email-derived, and rejected before Argon2.
  // The account-wide guard is a progressive Retry-After, never a hard lockout.
  const loginNetworkFailures = new BoundedCounter(600_000);
  // Reserve one of four shared Argon2 slots from concentrated multi-network sprays.
  const loginNetworkInFlight = new KeyedConcurrencyGate(3);
  const loginAccountInFlight = new KeyedConcurrencyGate(1);
  const loginIpFailures = new BoundedCounter(600_000);
  const accountFailures = new BoundedCounter(600_000);
  const recoverySendCooldown = new BoundedCounter(3_600_000);
  const emailFailures = new BoundedCounter(600_000);
  const ipFailures = new BoundedCounter(600_000);
  const EMAIL_FAIL_LIMIT = 5;
  const IP_FAIL_LIMIT = 20;
  const NETWORK_FAIL_LIMIT = 5;
  const LOGIN_IP_FAIL_LIMIT = 20;
  const ACCOUNT_RECOVERY_LIMIT = 10;
  const emailBucket = (email: string) =>
    createHash('sha256').update(email).digest('hex');
  const loginNetworkKey = (email: string, ip: string) =>
    `login:${emailBucket(email)}:${networkBucket(ip)}`;
  const argonNetworkBucket = (ip: string) => {
    const normalized = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
    if (isIP(normalized) === 4)
      return `${normalized.split('.').slice(0, 2).join('.')}.0.0/16`;
    const bucket = networkBucket(normalized);
    return bucket.endsWith('/64')
      ? `${bucket.slice(0, bucket.indexOf('::')).split(':').slice(0, 3).join(':')}::/48`
      : bucket;
  };
  const backoffMs = (failures: number, limit: number) =>
    failures < limit
      ? 0
      : Math.min(8_000, 250 * 2 ** Math.min(failures - limit, 5));
  const passwordKey = (accountId: string) => `pw:${accountId}`;
  const passwordBlocked = (accountId: string, ip: string) =>
    emailFailures.count(passwordKey(accountId)) >= EMAIL_FAIL_LIMIT ||
    ipFailures.count(ip) >= IP_FAIL_LIMIT;
  const passwordFailed = (accountId: string, ip: string) => {
    emailFailures.hit(passwordKey(accountId));
    ipFailures.hit(ip);
  };
  const EXPORTS_PER_WEEK = 10;
  const forgotSchema = z.object({ email: EmailSchema }).strict();
  const clientIp = (request: { raw: IncomingMessage }) =>
    app.clientIpForUpgrade(request.raw);
  const resetSchema = z
    .object({ token: z.string(), password: z.string() })
    .strict();
  const forgot = async (
    request: { body: unknown; raw: IncomingMessage; ip: string; log: Logger },
    reply: { code: (status: number) => { send: (body: unknown) => unknown } },
  ) => {
    const parsed = forgotSchema.safeParse(request.body);
    if (!parsed.success)
      return reply
        .code(400)
        .send({ code: 'INVALID_INPUT', message: 'Invalid email.' });
    const email = parsed.data.email.trim().toLowerCase();
    const emailKey = emailBucket(email);
    const throttled =
      limited(`forgot-ip:${clientIp(request)}`) ||
      limited(`forgot-email:${emailKey}`) ||
      recoverySendCooldown.count(emailKey) > 0;
    if (!throttled) {
      recoverySendCooldown.hit(emailKey);
      const { sent } = await requestPasswordReset(db, sender, email);
      void sent?.then((sendError) => {
        if (sendError)
          request.log.warn(
            { errorClass: sendError },
            'password reset not sent',
          );
      });
    }
    return reply.code(202).send({});
  };
  app.post('/api/password/forgot', forgot);
  app.post('/api/password-reset/request', forgot);
  const reset = async (
    request: { body: unknown; raw: IncomingMessage; ip: string },
    reply: { code: (status: number) => { send: (body: unknown) => unknown } },
  ) => {
    const parsed = resetSchema.safeParse(request.body);
    if (!parsed.success || !validPassword(parsed.data.password))
      return reply.code(400).send({
        code: 'INVALID_INPUT',
        message: 'Password must be at least 12 characters.',
      });
    const ip = clientIp(request);
    if (
      limited(`reset-ip:${ip}`) ||
      limited(
        `reset-token:${ip}:${createHash('sha256').update(parsed.data.token).digest('hex')}`,
      )
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
    const clientIp = request.ip;
    const networkKey = loginNetworkKey(email, clientIp);
    const ipKey = `login-ip:${clientIp}`;
    const cookieToken = tokenFromCookie(request.headers.cookie);
    const trustedSession = cookieToken
      ? await getSession(db, cookieToken).catch(() => undefined)
      : undefined;
    const trustedAccount = trustedSession
      ? await db.query('SELECT id FROM accounts WHERE email=$1', [email])
      : undefined;
    const trustedDevice =
      trustedSession?.account_id !== undefined &&
      trustedSession.account_id === trustedAccount?.rows[0]?.id;
    const networkDelay = trustedDevice
      ? 0
      : backoffMs(loginNetworkFailures.count(networkKey), NETWORK_FAIL_LIMIT);
    const ipDelay = backoffMs(
      loginIpFailures.count(ipKey),
      LOGIN_IP_FAIL_LIMIT,
    );
    const accountKey = emailBucket(email);
    const retryMs = Math.max(networkDelay, ipDelay);
    if (retryMs > 0) {
      return reply
        .code(429)
        .header('retry-after', String(Math.ceil(retryMs / 1000)))
        .send(badCredentials);
    }
    const releaseAccount = loginAccountInFlight.tryAcquire(accountKey);
    if (!releaseAccount)
      return reply.code(429).header('retry-after', '1').send(badCredentials);
    const releaseNetwork = trustedDevice
      ? undefined
      : loginNetworkInFlight.tryAcquire(argonNetworkBucket(clientIp));
    if (!trustedDevice && !releaseNetwork) {
      releaseAccount();
      return reply.code(429).header('retry-after', '1').send(badCredentials);
    }
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
    } finally {
      releaseNetwork?.();
      releaseAccount();
    }
    if (result.kind === 'invalid') {
      loginNetworkFailures.hit(networkKey);
      loginIpFailures.hit(ipKey);
      const accountFailuresAfterAttempt = accountFailures.hit(accountKey);
      if (accountFailuresAfterAttempt >= ACCOUNT_RECOVERY_LIMIT) {
        const emailKey = accountKey;
        if (
          recoverySendCooldown.count(emailKey) === 0 &&
          !limited(`forgot-email:${emailKey}`)
        ) {
          recoverySendCooldown.hit(emailKey);
          void requestPasswordResetIfMissing(db, sender, email)
            .then(({ sent }) =>
              sent?.then((sendError) => {
                if (sendError)
                  request.log.warn(
                    { errorClass: sendError },
                    'password recovery email not sent',
                  );
              }),
            )
            .catch((error: unknown) =>
              request.log.warn(
                { errorClass: error instanceof Error ? error.name : 'unknown' },
                'password recovery request failed',
              ),
            );
        }
      }
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
    loginNetworkFailures.clear(networkKey);
    accountFailures.clear(accountKey);
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
      'SELECT id,email,display_name,is_adult,age_checked_at,mature_opt_out FROM accounts WHERE id=$1',
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
        matureOptOut: a.mature_opt_out === true,
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
    if (limited(`name:${session.account_id}`))
      return reply.code(429).send({
        code: 'RATE_LIMITED',
        message: 'Too many requests. Try again later.',
      });
    const decision = await app.inputGate.check({
      text: name,
      surface: 'display-name',
      accountId: session.account_id,
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
        message: 'That display name cannot be used.',
      });
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
    if (passwordBlocked(session.account_id, clientIp(request)))
      return reply.code(429).send({
        code: 'RATE_LIMITED',
        message: 'Too many password attempts. Try again later.',
      });
    const row = (
      await db.query('SELECT password_hash FROM accounts WHERE id=$1', [
        session.account_id,
      ])
    ).rows[0];
    if (
      !row ||
      !(await verifyPassword(row.password_hash, parsed.data.currentPassword))
    ) {
      passwordFailed(session.account_id, clientIp(request));
      return reply.code(403).send({
        code: 'BAD_CREDENTIALS',
        message: 'Current password is incorrect.',
      });
    }
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
    if (exportCooldown.count(session.account_id) > 0)
      return reply.code(429).send({
        code: 'RATE_LIMITED',
        message: 'Please wait before requesting another export.',
      });
    const body = request.body as { password?: unknown } | null;
    // Throttle first so guesses never reach argon2.
    if (passwordBlocked(session.account_id, clientIp(request)))
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
        passwordFailed(session.account_id, clientIp(request));
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
    exportCooldown.hit(session.account_id);
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
    if (passwordBlocked(session.account_id, clientIp(request)))
      return reply.code(429).send({
        code: 'RATE_LIMITED',
        message: 'Too many password attempts. Try again later.',
      });
    if (
      !(await requestDeletion(db, session.account_id, parsed.data.password))
    ) {
      passwordFailed(session.account_id, clientIp(request));
      return reply
        .code(403)
        .send({ code: 'BAD_CREDENTIALS', message: 'Password is incorrect.' });
    }
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
    const decision = await app.inputGate.check({
      text: parsed.data.displayName,
      surface: 'display-name',
      ip: request.ip,
    });
    if (decision === 'limited')
      return reply.code(429).send({ message: 'Too many requests' });
    if (decision === 'block')
      return reply.code(400).send({
        code: 'CONTENT_REJECTED',
        message: 'That display name cannot be used.',
      });
    try {
      const result = await signup(db, sender, parsed.data, {
        cookieSecret,
        cookie: request.headers.cookie,
      });
      void result.sent?.then((sendError) => {
        if (sendError)
          request.log.warn(
            { errorClass: sendError },
            'verification email not sent',
          );
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
  const resendSchema = z.object({ email: EmailSchema }).strict();
  app.post('/api/verify-email/resend', async (request, reply) => {
    const parsed = resendSchema.safeParse(request.body);
    if (!parsed.success)
      return reply
        .code(400)
        .send({ code: 'INVALID_INPUT', message: 'Invalid email.' });
    const email = parsed.data.email.trim().toLowerCase();
    const throttled =
      limited(`resend-ip:${clientIp(request)}`) ||
      limited(`resend-email:${email}`);
    if (!throttled) {
      const token = await resendVerification(db, email);
      // Not awaited: send latency must not distinguish known from unknown addresses.
      if (token)
        void sendBestEffort(() => sender.sendVerification(email, token)).then(
          (sendError) => {
            if (sendError)
              request.log.warn(
                { errorClass: sendError },
                'verification resend not sent',
              );
          },
        );
    }
    return reply.code(202).send(signupResponse);
  });
}
