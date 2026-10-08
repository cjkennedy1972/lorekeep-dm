import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { randomUUID } from 'node:crypto';
import { createTestDatabase } from './testDb.js';
import { registerOperatorRoutes } from '../../src/routes/operator.js';
import { createLogger } from '../../src/app.js';
import { hashToken } from '../../src/accounts/signup.js';
import {
  decryptEndpointKey,
  encryptEndpointKey,
  readEndpoints,
  saveEndpoint,
} from '../../src/llm/config.js';
import {
  createEgressGuard,
  type TransportRequest,
} from '../../src/llm/egress.js';

const token = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
describe('operator endpoint configuration', () => {
  it('encrypts distinct envelopes, fails closed, denies non-operators, and never leaks key', async () => {
    const db = await createTestDatabase();
    const output: string[] = [];
    const operatorId = randomUUID(),
      playerId = randomUUID();
    const app = Fastify({
      loggerInstance: createLogger({
        write(chunk: string) {
          output.push(chunk);
        },
      }),
    });
    try {
      await db.pool.query(
        'CREATE TABLE accounts(id uuid PRIMARY KEY,email text NOT NULL,status text NOT NULL)',
      );
      await db.pool.query(
        'CREATE TABLE auth_sessions(token_hash text PRIMARY KEY,account_id uuid NOT NULL REFERENCES accounts(id),expires_at timestamptz NOT NULL,absolute_expires_at timestamptz NOT NULL,last_active_at timestamptz NOT NULL)',
      );
      await db.pool.query(
        `CREATE TABLE operator_endpoints(slot text PRIMARY KEY,base_url text NOT NULL,model text NOT NULL,api_style text NOT NULL,encrypted_key text,key_fingerprint text,context_window integer,unsupported_tool_schema_keywords jsonb NOT NULL DEFAULT '[]'::jsonb,probe jsonb,updated_at timestamptz NOT NULL DEFAULT now())`,
      );
      await db.pool.query(
        `CREATE TABLE operator_endpoint_audit(id bigserial PRIMARY KEY,slot text,action text,created_at timestamptz DEFAULT now(),expires_at timestamptz DEFAULT now()+interval '30 days')`,
      );
      await db.pool.query(
        "INSERT INTO accounts VALUES($1,'op@example.test','active'),($2,'player@example.test','active')",
        [operatorId, playerId],
      );
      for (const [account, sessionToken] of [
        [operatorId, token],
        [playerId, 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB'],
      ] as const)
        await db.pool.query(
          "INSERT INTO auth_sessions VALUES($1,$2,now()+interval '1 day',now()+interval '2 days',now())",
          [hashToken(sessionToken), account],
        );
      const sent: TransportRequest[] = [];
      const egress = createEgressGuard({
        resolver: async () => [{ address: '93.184.216.34', family: 4 }],
        transport: async (req) => {
          sent.push(req);
          return {
            status: 200,
            headers: {},
            body: new Response(
              'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
            ).body,
          };
        },
      });
      // Exercise route auth with an operator resolver backed by the actual account email.
      registerOperatorRoutes(app, db.pool, async (id) => id === operatorId, {
        egress,
      });
      const denied = await app.inject({
        method: 'PUT',
        url: '/api/operator/endpoints/fast',
        headers: { cookie: 'sid=BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB' },
        payload: {
          baseUrl: 'https://api.example.test/v1',
          model: 'm',
          apiStyle: 'openai',
          apiKey: ['operator-', 'credential', '-sentinel'].join(''),
        },
      });
      expect(denied.statusCode).toBe(404);
      const player = await app.inject({
        url: '/api/operator/endpoints',
        headers: { cookie: 'sid=BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB' },
      });
      expect(player.statusCode).toBe(404);
      const allowed = await app.inject({
        method: 'PUT',
        url: '/api/operator/endpoints/fast',
        headers: { cookie: `sid=${token}` },
        payload: {
          baseUrl: 'https://api.example.test/v1',
          model: 'm',
          apiStyle: 'openai',
          apiKey: ['operator-', 'credential', '-sentinel'].join(''),
          contextWindow: 32768,
          unsupportedToolSchemaKeywords: ['pattern', 'maxLength'],
        },
      });
      expect(allowed.statusCode).toBe(200);
      expect(allowed.body).not.toContain(
        ['operator-', 'credential', '-sentinel'].join(''),
      );
      // Exercise a second save to assert random nonce uniqueness.
      const first = allowed.json().endpoint;
      const firstCipher = (
        await db.pool.query('SELECT encrypted_key FROM operator_endpoints')
      ).rows[0]!.encrypted_key as string;
      const secondResponse = await app.inject({
        method: 'PUT',
        url: '/api/operator/endpoints/fast',
        headers: { cookie: `sid=${token}` },
        payload: {
          baseUrl: 'https://api.example.test/v1',
          model: 'm',
          apiStyle: 'openai',
          apiKey: ['operator-', 'credential', '-sentinel'].join(''),
          contextWindow: 32768,
          unsupportedToolSchemaKeywords: ['pattern', 'maxLength'],
        },
      });
      const second = secondResponse.json().endpoint;
      const secondCipher = (
        await db.pool.query('SELECT encrypted_key FROM operator_endpoints')
      ).rows[0]!.encrypted_key as string;
      expect(firstCipher).not.toBe(secondCipher);
      expect(firstCipher).not.toContain(
        ['operator-', 'credential', '-sentinel'].join(''),
      );
      expect(() => decryptEndpointKey(firstCipher, '22'.repeat(32))).toThrow(
        'Endpoint credential unavailable',
      );
      expect(() =>
        decryptEndpointKey(firstCipher.slice(0, -2) + 'aa', '11'.repeat(32)),
      ).toThrow('Endpoint credential unavailable');
      expect((await readEndpoints(db.pool))[0]).not.toHaveProperty('apiKey');
      expect(
        JSON.stringify([first, second, await readEndpoints(db.pool)]),
      ).not.toContain(['operator-', 'credential', '-sentinel'].join(''));
      expect(
        JSON.stringify(
          sent.map((r) => ({
            url: r.url.toString(),
            headers: r.headers,
            body: r.body,
          })),
        ),
      ).not.toContain(['operator-', 'credential', '-sentinel'].join(''));
      expect(output.join('')).not.toContain(
        ['operator-', 'credential', '-sentinel'].join(''),
      );
      expect(first.keySet).toBe(true);
      expect(first.unsupportedToolSchemaKeywords).toEqual([
        'pattern',
        'maxLength',
      ]);
      expect(second.unsupportedToolSchemaKeywords).toEqual([
        'pattern',
        'maxLength',
      ]);
      expect(
        (await readEndpoints(db.pool))[0]?.unsupportedToolSchemaKeywords,
      ).toEqual(['pattern', 'maxLength']);
    } finally {
      await app.close();
      await db.close();
    }
  });
  it('validates and defaults unsupported tool schema keyword lists', async () => {
    const db = await createTestDatabase();
    try {
      await db.pool.query(
        `CREATE TABLE operator_endpoints(slot text PRIMARY KEY,base_url text NOT NULL,model text NOT NULL,api_style text NOT NULL,encrypted_key text,key_fingerprint text,context_window integer,unsupported_tool_schema_keywords jsonb NOT NULL DEFAULT '[]'::jsonb,probe jsonb,updated_at timestamptz NOT NULL DEFAULT now())`,
      );
      await db.pool.query(
        `CREATE TABLE operator_endpoint_audit(id bigserial PRIMARY KEY,slot text,action text,created_at timestamptz DEFAULT now(),expires_at timestamptz DEFAULT now()+interval '30 days')`,
      );
      const egress = createEgressGuard({
        resolver: async () => [{ address: '93.184.216.34', family: 4 }],
        transport: async () => ({ status: 200, headers: {}, body: null }),
      });
      const base = {
        baseUrl: 'https://api.example.test/v1',
        model: 'm',
        apiStyle: 'openai',
      };
      await expect(
        saveEndpoint(
          db.pool,
          'fast',
          { ...base, unsupportedToolSchemaKeywords: ['pattern', 'pattern'] },
          egress,
        ),
      ).rejects.toMatchObject({ name: 'ZodError' });
      const saved = await saveEndpoint(db.pool, 'fast', base, egress);
      expect(saved.unsupportedToolSchemaKeywords).toEqual([]);
      const configured = await saveEndpoint(
        db.pool,
        'fast',
        { ...base, unsupportedToolSchemaKeywords: ['pattern', 'maxLength'] },
        egress,
      );
      expect(configured.unsupportedToolSchemaKeywords).toEqual([
        'pattern',
        'maxLength',
      ]);
      expect(
        (await readEndpoints(db.pool))[0]?.unsupportedToolSchemaKeywords,
      ).toEqual(['pattern', 'maxLength']);
    } finally {
      await db.close();
    }
  });
  it('rejects unsafe save URLs before network access', async () => {
    const guard = createEgressGuard({
      resolver: async () => [{ address: '127.0.0.1', family: 4 }],
      transport: async () => {
        throw new Error('must not connect');
      },
    });
    await expect(
      guard.validate('https://internal.example.test/v1'),
    ).rejects.toMatchObject({ code: 'egress-private-address' });
    expect(encryptEndpointKey('secret', '11'.repeat(32))).not.toContain(
      'secret',
    );
  });
});
