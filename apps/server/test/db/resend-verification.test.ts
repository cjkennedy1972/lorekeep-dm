import { allowInputGate } from '../support/allowInputGate.js';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/app.js';
import { MemoryEmailSender, type EmailSender } from '../../src/email/sender.js';
import { signup, signupResponse } from '../../src/accounts/signup.js';
import { verifyEmail } from '../../src/accounts/verify.js';
import { requestPasswordReset } from '../../src/accounts/reset.js';

const db = new Pool({ connectionString: process.env.DATABASE_URL });
afterAll(async () => db.end());

class FailingEmailSender implements EmailSender {
  async sendVerification(): Promise<void> {
    throw new TypeError('fetch failed for player@example.test');
  }
  async sendPasswordReset(): Promise<void> {
    throw new TypeError('fetch failed for player@example.test');
  }
}

const password = 'a-unique-password-123';
const newEmail = () => `${randomUUID()}@example.test`;
const signupBody = (email: string) => ({
  email,
  birthdate: '1990-01-01',
  password,
  displayName: 'Player',
  termsVersion: 'v1',
});
const options = { cookieSecret: 'test-secret' };

async function accountId(email: string) {
  return (await db.query('SELECT id FROM accounts WHERE email=$1', [email]))
    .rows[0]?.id as string | undefined;
}

async function verifyTokenRows(id: string) {
  return (
    await db.query(
      "SELECT used_at FROM email_tokens WHERE account_id=$1 AND kind='verify' ORDER BY expires_at",
      [id],
    )
  ).rows as { used_at: Date | null }[];
}

async function cleanup(email: string) {
  await db.query('DELETE FROM accounts WHERE email=$1', [email]);
}

async function waitForMessages(sender: MemoryEmailSender, count: number) {
  await vi.waitFor(() => expect(sender.messages).toHaveLength(count));
}

describe('signup survives a failing verification send', () => {
  it('returns the normal response and keeps the pending account and token', async () => {
    const email = newEmail();
    const app = createApp(
      db,
      {
        inputGate: allowInputGate,
        sender: new FailingEmailSender(),
        cookieSecret: 'test-secret',
      },
      { inputGate: allowInputGate },
    );
    const res = await app.inject({
      method: 'POST',
      url: '/api/signup',
      payload: signupBody(email),
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual(signupResponse);
    const id = await accountId(email);
    expect(id).toBeTruthy();
    expect(await verifyTokenRows(id!)).toHaveLength(1);
    await app.close();
    await cleanup(email);
  });

  it('returns the same response for a failing send as for a successful one', async () => {
    const ok = newEmail();
    const failed = newEmail();
    const okRes = await createApp(
      db,
      {
        inputGate: allowInputGate,
        sender: new MemoryEmailSender(),
        cookieSecret: 'test-secret',
      },
      { inputGate: allowInputGate },
    ).inject({ method: 'POST', url: '/api/signup', payload: signupBody(ok) });
    const failRes = await createApp(
      db,
      {
        inputGate: allowInputGate,
        sender: new FailingEmailSender(),
        cookieSecret: 'test-secret',
      },
      { inputGate: allowInputGate },
    ).inject({
      method: 'POST',
      url: '/api/signup',
      payload: signupBody(failed),
    });
    expect(failRes.statusCode).toBe(okRes.statusCode);
    expect(failRes.body).toBe(okRes.body);
    await cleanup(ok);
    await cleanup(failed);
  });

  it('lets the user recover with resend after a failed signup send', async () => {
    const email = newEmail();
    const failing = new FailingEmailSender();
    await signup(db, failing, { ...signupBody(email), password }, options);
    const sender = new MemoryEmailSender();
    const app = createApp(
      db,
      { inputGate: allowInputGate, sender, cookieSecret: 'test-secret' },
      { inputGate: allowInputGate },
    );
    const res = await app.inject({
      method: 'POST',
      url: '/api/verify-email/resend',
      payload: { email },
    });
    expect(res.statusCode).toBe(202);
    await waitForMessages(sender, 1);
    expect(await verifyEmail(db, sender.messages[0]!.token, password)).toBe(
      true,
    );
    await app.close();
    await cleanup(email);
  });
});

describe('password reset survives a failing send', () => {
  it('still reports success and leaves the reset token issued', async () => {
    const email = newEmail();
    const sender = new MemoryEmailSender();
    await signup(db, sender, signupBody(email), options);
    await verifyEmail(db, sender.messages[0]!.token, password);
    const result = await requestPasswordReset(
      db,
      new FailingEmailSender(),
      email,
    );
    expect(await result.sent).toBe('TypeError');
    const reset = (
      await db.query(
        "SELECT count(*)::int AS n FROM email_tokens t JOIN accounts a ON a.id=t.account_id WHERE a.email=$1 AND t.kind='reset' AND t.used_at IS NULL",
        [email],
      )
    ).rows[0].n;
    expect(reset).toBe(1);
    await cleanup(email);
  });
});

describe('POST /api/verify-email/resend', () => {
  it('re-issues a fresh token, retires the old one, and only the new one verifies', async () => {
    const email = newEmail();
    const sender = new MemoryEmailSender();
    await signup(db, new FailingEmailSender(), signupBody(email), options);
    const id = (await accountId(email))!;
    const app = createApp(
      db,
      { inputGate: allowInputGate, sender, cookieSecret: 'test-secret' },
      { inputGate: allowInputGate },
    );
    const res = await app.inject({
      method: 'POST',
      url: '/api/verify-email/resend',
      payload: { email },
    });
    expect(res.statusCode).toBe(202);
    await waitForMessages(sender, 1);
    const fresh = sender.messages[0]!.token;
    const rows = await verifyTokenRows(id);
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.used_at === null)).toHaveLength(1);

    const stale = (
      await db.query(
        "SELECT token_hash FROM email_tokens WHERE account_id=$1 AND used_at IS NOT NULL AND kind='verify'",
        [id],
      )
    ).rows[0];
    expect(stale).toBeTruthy();
    expect(await verifyEmail(db, fresh, password)).toBe(true);
    await app.close();
    await cleanup(email);
  });

  it('does not reveal whether the address exists or is already verified', async () => {
    const pending = newEmail();
    const active = newEmail();
    const unknown = newEmail();
    const sender = new MemoryEmailSender();
    await signup(db, sender, signupBody(pending), options);
    await signup(db, sender, signupBody(active), options);
    await verifyEmail(db, sender.messages[1]!.token, password);
    const app = createApp(
      db,
      { inputGate: allowInputGate, sender, cookieSecret: 'test-secret' },
      { inputGate: allowInputGate },
    );
    const send = (email: string, ip: string) =>
      app.inject({
        method: 'POST',
        url: '/api/verify-email/resend',
        remoteAddress: ip,
        payload: { email },
      });
    const [a, b, c] = [
      await send(pending, '10.1.0.1'),
      await send(active, '10.1.0.2'),
      await send(unknown, '10.1.0.3'),
    ];
    expect(a.statusCode).toBe(202);
    expect(b.statusCode).toBe(202);
    expect(c.statusCode).toBe(202);
    expect(b.body).toBe(a.body);
    expect(c.body).toBe(a.body);
    expect(a.json()).toEqual(signupResponse);
    await waitForMessages(sender, 3);
    expect(sender.messages.slice(2).map((m) => m.email)).toEqual([pending]);
    await app.close();
    await cleanup(pending);
    await cleanup(active);
  });

  it('throttles repeated resends per address with the same response and no new token', async () => {
    const email = newEmail();
    const sender = new MemoryEmailSender();
    await signup(db, new FailingEmailSender(), signupBody(email), options);
    const id = (await accountId(email))!;
    const app = createApp(
      db,
      { inputGate: allowInputGate, sender, cookieSecret: 'test-secret' },
      { inputGate: allowInputGate },
    );
    const responses = [];
    for (let i = 0; i < 7; i++)
      responses.push(
        await app.inject({
          method: 'POST',
          url: '/api/verify-email/resend',
          remoteAddress: `10.2.0.${i + 1}`,
          payload: { email },
        }),
      );
    expect(new Set(responses.map((r) => r.statusCode))).toEqual(new Set([202]));
    expect(new Set(responses.map((r) => r.body)).size).toBe(1);
    await waitForMessages(sender, 5);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(sender.messages).toHaveLength(5);
    expect(await verifyTokenRows(id)).toHaveLength(6);
    await app.close();
    await cleanup(email);
  });

  it('rejects malformed email without touching accounts', async () => {
    const app = createApp(
      db,
      {
        inputGate: allowInputGate,
        sender: new MemoryEmailSender(),
        cookieSecret: 'test-secret',
      },
      { inputGate: allowInputGate },
    );
    const res = await app.inject({
      method: 'POST',
      url: '/api/verify-email/resend',
      payload: { email: 'not-an-email' },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});
