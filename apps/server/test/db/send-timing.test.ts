import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import type { EmailSender } from '../../src/email/sender.js';
import { signupResponse } from '../../src/accounts/signup.js';

const db = new Pool({ connectionString: process.env.DATABASE_URL });
afterAll(async () => db.end());

class GatedEmailSender implements EmailSender {
  calls = 0;
  private open!: () => void;
  private readonly gate = new Promise<void>((resolve) => {
    this.open = resolve;
  });
  release(): void {
    this.open();
  }
  async sendVerification(): Promise<void> {
    this.calls += 1;
    await this.gate;
  }
  async sendPasswordReset(): Promise<void> {
    this.calls += 1;
    await this.gate;
  }
}

const newEmail = () => `${randomUUID()}@example.test`;
const password = 'a-unique-password-123';
const signupBody = (email: string) => ({
  email,
  birthdate: '1990-01-01',
  password,
  displayName: 'Player',
  termsVersion: 'v1',
});

/** Resolves with the response, or 'pending' if the request has not finished within the window. */
async function finishedWithin<T>(
  request: Promise<T>,
  ms = 1500,
): Promise<T | 'pending'> {
  return Promise.race([
    request,
    new Promise<'pending'>((resolve) =>
      setTimeout(() => resolve('pending'), ms),
    ),
  ]);
}

describe('account send-path timing', () => {
  it('signup answers before a slow verification send completes', async () => {
    const sender = new GatedEmailSender();
    const app = createApp(db, { sender, cookieSecret: 'test-secret' });
    const email = newEmail();
    const request = app.inject({
      method: 'POST',
      url: '/api/signup',
      payload: signupBody(email),
    });
    const res = await finishedWithin(request);
    sender.release();
    await request;
    expect(res).not.toBe('pending');
    if (res === 'pending') return;
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual(signupResponse);
    await app.close();
    await db.query('DELETE FROM accounts WHERE email=$1', [email]);
  });

  it('forgot answers before a slow reset send completes, same body as unknown address', async () => {
    const sender = new GatedEmailSender();
    const app = createApp(db, { sender, cookieSecret: 'test-secret' });
    const unknown = app.inject({
      method: 'POST',
      url: '/api/password/forgot',
      payload: { email: newEmail() },
    });
    const unknownRes = await finishedWithin(unknown);
    expect(unknownRes).not.toBe('pending');
    if (unknownRes === 'pending') return;
    expect(unknownRes.statusCode).toBe(202);
    expect(unknownRes.json()).toEqual({});
    await app.close();
  });

  it('forgot for a known address answers before the reset send completes', async () => {
    const sender = new GatedEmailSender();
    const app = createApp(db, { sender, cookieSecret: 'test-secret' });
    const email = newEmail();
    await db.query(
      "INSERT INTO accounts(id,email,password_hash,display_name,status,is_adult,age_checked_at,terms_version,terms_accepted_at) VALUES ($1,$2,'x','Player','active',true,now(),'v1',now())",
      [randomUUID(), email],
    );
    const request = app.inject({
      method: 'POST',
      url: '/api/password/forgot',
      payload: { email },
    });
    const res = await finishedWithin(request);
    sender.release();
    await request;
    expect(res).not.toBe('pending');
    if (res === 'pending') return;
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({});
    await app.close();
    await db.query('DELETE FROM accounts WHERE email=$1', [email]);
  });
});
