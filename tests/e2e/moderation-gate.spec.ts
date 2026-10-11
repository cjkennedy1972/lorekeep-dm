import { randomUUID } from 'node:crypto';
import { afterAll, expect, test } from 'vitest';
import { judge, proofDb, startServer } from './support.js';

let server: Awaited<ReturnType<typeof startServer>>;
afterAll(async () => server?.stop());

const signup = (displayName: string) =>
  fetch(`${server.url}/api/signup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: server.url },
    body: JSON.stringify({
      email: `${randomUUID()}@example.test`,
      password: 'e2e-proof-password-2026',
      displayName,
      birthdate: '1990-01-01',
      termsVersion: 'm0-proof',
    }),
  });

test('a judge block rejects the display name privately and logs no text', async () => {
  server = await startServer();
  const name = 'Blocked Name Probe';
  const judgedBefore = judge.judgeCalls;
  judge.verdict = 'block';
  try {
    const res = await signup(name);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string; message: string };
    expect(body.code).toBe('CONTENT_REJECTED');
    expect(JSON.stringify(body)).not.toContain(name);
    expect(judge.judgeCalls).toBe(judgedBefore + 1);
    const row = (
      await proofDb.query<{
        category: string;
        source: string;
        fail_closed_row: string | null;
        raw: string;
      }>(
        `SELECT category, source, fail_closed_row, to_jsonb(m)::text AS raw
         FROM moderation_log m WHERE surface='display-name' ORDER BY written_at DESC LIMIT 1`,
      )
    ).rows[0];
    expect(row).toMatchObject({
      category: 'language',
      source: 'judge',
      fail_closed_row: null,
    });
    expect(row?.raw).not.toContain(name);
  } finally {
    judge.verdict = 'allow';
  }
});

test('a stopped judge endpoint fails closed on the display name', async () => {
  await judge.stop();
  try {
    const name = 'Unreviewed Name Probe';
    const res = await signup(name);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe(
      'CONTENT_REJECTED',
    );
    const row = (
      await proofDb.query<{ source: string; fail_closed_row: string | null }>(
        `SELECT source, fail_closed_row FROM moderation_log m WHERE surface='display-name' ORDER BY written_at DESC LIMIT 1`,
      )
    ).rows[0];
    expect(row).toMatchObject({
      source: 'failclosed',
      fail_closed_row: 'hard-floor',
    });
    const created = await proofDb.query(
      'SELECT 1 FROM accounts WHERE display_name=$1',
      [name],
    );
    expect(created.rowCount).toBe(0);
  } finally {
    await judge.start();
  }
});
