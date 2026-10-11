import { allowInputGate } from '../support/allowInputGate.js';
import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { hashPassword } from '../../src/accounts/password.js';
import { badCredentials } from '../../src/accounts/login.js';

async function setup() {
  const password_hash = await hashPassword('correct-password-1');
  let accountQueries = 0;
  const db = {
    connect: async () => undefined,
    query: async (sql: string, args: unknown[]) => {
      if (/FROM accounts WHERE email/.test(sql)) {
        accountQueries++;
        return {
          rows:
            args[0] === 'known@example.test'
              ? [{ id: 'a', password_hash, status: 'active' }]
              : [],
        };
      }
      return { rows: [], rowCount: 0 };
    },
  };
  const app = createApp(db as never, { inputGate: allowInputGate });
  const post = (email: string, ip: string, password = 'wrong-password-1') =>
    app.inject({
      method: 'POST',
      url: '/api/login',
      remoteAddress: ip,
      payload: { email, password },
    });
  return { app, post, queries: () => accountQueries, password_hash };
}

describe('login throttle', () => {
  it('blocks per ip+email before any password work and keeps the body shape', async () => {
    const { app, post, queries } = await setup();
    for (let i = 0; i < 5; i++)
      expect((await post('known@example.test', '10.0.0.1')).statusCode).toBe(
        401,
      );
    const before = queries();
    const blocked = await post(
      'known@example.test',
      '10.0.0.1',
      'correct-password-1',
    );
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json()).toEqual(badCredentials);
    expect(queries()).toBe(before); // no db lookup, hence no argon2
    await app.close();
  });
  it('blocks one ip rotating emails after 20 failures', async () => {
    const { app, post, queries } = await setup();
    for (let i = 0; i < 20; i++)
      expect((await post(`u${i}@example.test`, '10.0.0.2')).statusCode).toBe(
        401,
      );
    const before = queries();
    const blocked = await post('fresh@example.test', '10.0.0.2');
    expect(blocked.statusCode).toBe(429);
    expect(queries()).toBe(before);
    expect((await post('fresh@example.test', '10.0.0.3')).statusCode).toBe(401);
    await app.close();
  });
  it('throttles one account across rotating IPs before any password work', async () => {
    const { app, post, queries } = await setup();
    for (let i = 0; i < 10; i++)
      expect((await post('known@example.test', `10.0.1.${i}`)).statusCode).toBe(
        401,
      );
    const before = queries();
    const blocked = await post(
      'known@example.test',
      '10.0.2.1',
      'correct-password-1',
    );
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json()).toEqual(badCredentials);
    expect(queries()).toBe(before);
    await app.close();
  });
  it('unknown email and wrong password bodies are byte-identical', async () => {
    const { app, post } = await setup();
    const unknown = await post('nobody@example.test', '10.0.0.4');
    const wrong = await post('known@example.test', '10.0.0.4');
    expect(unknown.statusCode).toBe(401);
    expect(unknown.body).toBe(wrong.body);
    await app.close();
  });
});
