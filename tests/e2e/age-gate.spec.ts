import { expect, test } from 'vitest';
import { proofDb, startServer, proofEmail } from './support.js';

test('under-18 signup is refused and database-wide birthdate scan is empty', async () => {
  const server = await startServer();
  try {
    const email = proofEmail('minor');
    const response = await fetch(`${server.url}/api/signup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: server.url },
      body: JSON.stringify({
        email,
        password: 'e2e-proof-password-2026',
        displayName: 'Minor',
        birthdate: '2015-01-01',
        termsVersion: 'm0-proof',
      }),
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: 'UNDERAGE' });
    expect(
      (await proofDb.query('SELECT 1 FROM accounts WHERE email=$1', [email]))
        .rowCount,
    ).toBe(0);

    const columns = (
      await proofDb.query<{ table_name: string; column_name: string }>(
        `SELECT table_name,column_name FROM information_schema.columns WHERE table_schema='public' AND column_name ~* '(birthdate|dob|birth_date|age_band|guardian|consent)'`,
      )
    ).rows;
    expect(columns).toEqual([]);
    const relation = await proofDb.query<{ name: string }>(
      `SELECT quote_ident(table_schema)||'.'||quote_ident(table_name) AS name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'`,
    );
    const hits: string[] = [];
    for (const { name } of relation.rows) {
      const [schema, table] = name.split('.');
      const result = await proofDb.query(
        `SELECT 1 FROM ${schema}.${table} WHERE to_jsonb(${table})::text ~* '(birthdate|dob|birth_date)' LIMIT 1`,
      );
      if (result.rowCount) hits.push(name);
    }
    expect(hits).toEqual([]);
  } finally {
    await server.stop();
  }
});
