import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../../src/config.js';
import {
  ConsoleEmailSender,
  emailSenderFromConfig,
} from '../../src/email/sender.js';
import { ResendEmailSender } from '../../src/email/resend.js';

const token = 'TOKEN-abc_123';
const base = {
  apiKey: 're_test_key',
  from: 'Lorekeep <noreply@example.test>',
  appBaseUrl: 'https://app.example.test/',
};

function fakeFetch(response: Response | Error) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = (async (
    url: string | URL | Request,
    init?: RequestInit,
  ) => {
    calls.push({ url: String(url), init: init ?? {} });
    if (response instanceof Error) throw response;
    return response;
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ResendEmailSender', () => {
  it('posts a verification email with the Resend request shape and a verify link', async () => {
    const { calls, fetchImpl } = fakeFetch(new Response('{}', { status: 200 }));
    const sender = new ResendEmailSender({ ...base, fetch: fetchImpl });

    await sender.sendVerification('player@example.test', token);

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.resend.com/emails');
    expect(calls[0].init.method).toBe('POST');
    expect(calls[0].init.headers).toEqual({
      authorization: 'Bearer re_test_key',
      'content-type': 'application/json',
    });
    const body = JSON.parse(String(calls[0].init.body));
    expect(body).toMatchObject({
      from: base.from,
      to: ['player@example.test'],
    });
    expect(body.subject).toEqual(expect.any(String));
    expect(body.text).toContain(
      `https://app.example.test/verify?token=${token}`,
    );
  });

  it('posts a password reset email with a reset link', async () => {
    const { calls, fetchImpl } = fakeFetch(new Response('{}', { status: 200 }));
    const sender = new ResendEmailSender({ ...base, fetch: fetchImpl });

    await sender.sendPasswordReset('player@example.test', token);

    const body = JSON.parse(String(calls[0].init.body));
    expect(body.to).toEqual(['player@example.test']);
    expect(body.text).toContain(
      `https://app.example.test/reset?token=${token}`,
    );
  });

  it('rejects with the status only when Resend refuses the message', async () => {
    const { fetchImpl } = fakeFetch(
      new Response('{"message":"player@example.test is invalid"}', {
        status: 422,
      }),
    );
    const sender = new ResendEmailSender({ ...base, fetch: fetchImpl });

    const failure = sender.sendVerification('player@example.test', token);
    await expect(failure).rejects.toThrow(
      'Email delivery failed with status 422',
    );
    await expect(failure).rejects.not.toThrow(token);
    await expect(failure).rejects.not.toThrow('player@example.test');
    await expect(failure).rejects.not.toThrow(base.apiKey);
  });

  it('propagates network failures without the token or key', async () => {
    const { fetchImpl } = fakeFetch(new TypeError('fetch failed'));
    const sender = new ResendEmailSender({ ...base, fetch: fetchImpl });

    await expect(
      sender.sendPasswordReset('player@example.test', token),
    ).rejects.toThrow('fetch failed');
  });

  it('never writes the token or link to the console', async () => {
    const logs = [
      vi.spyOn(console, 'info'),
      vi.spyOn(console, 'log'),
      vi.spyOn(console, 'error'),
      vi.spyOn(console, 'warn'),
    ];
    const { fetchImpl } = fakeFetch(new Response('nope', { status: 500 }));
    const sender = new ResendEmailSender({ ...base, fetch: fetchImpl });

    await sender.sendVerification('player@example.test', token).catch(() => {});

    for (const spy of logs) expect(spy).not.toHaveBeenCalled();
  });
});

describe('emailSenderFromConfig boot policy', () => {
  const production = {
    DATABASE_URL: 'postgres://localhost/lorekeep',
    NODE_ENV: 'production',
    RESEND_API_KEY: 're_live',
    EMAIL_FROM: 'Lorekeep <noreply@example.test>',
    APP_BASE_URL: 'https://app.example.test',
  } as const;

  it('uses Resend when fully configured in production', () => {
    const config = loadConfig({ ...production });
    expect(emailSenderFromConfig(config)).toBeInstanceOf(ResendEmailSender);
  });

  it('refuses to boot in production without a sender', () => {
    const config = loadConfig({
      DATABASE_URL: production.DATABASE_URL,
      NODE_ENV: 'production',
    });
    expect(() => emailSenderFromConfig(config)).toThrow(/RESEND_API_KEY/);
  });

  it('refuses to boot in production with a partial sender configuration', () => {
    const config = loadConfig({
      DATABASE_URL: production.DATABASE_URL,
      NODE_ENV: 'production',
      RESEND_API_KEY: 're_live',
    });
    expect(() => emailSenderFromConfig(config)).toThrow(/EMAIL_FROM/);
  });

  it('keeps the console sender for development and test without configuration', () => {
    for (const NODE_ENV of ['development', 'test']) {
      const config = loadConfig({
        DATABASE_URL: production.DATABASE_URL,
        NODE_ENV,
      });
      expect(emailSenderFromConfig(config)).toBeInstanceOf(ConsoleEmailSender);
    }
  });
});
