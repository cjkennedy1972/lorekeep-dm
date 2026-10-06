import { expect, test } from 'vitest';
import {
  accountPiiReferences,
  createVerifiedAccount,
  proofDb,
  startServer,
} from './support.js';
import { runSweep } from '../../apps/server/src/retention/sweeper.js';
import { LocalObjectStore } from '../../apps/server/src/storage/objectStore.js';

test('deletion request plus retention sweeper removes account PII', async () => {
  const server = await startServer();
  try {
    const account = await createVerifiedAccount(server.url);
    await proofDb.query("UPDATE accounts SET status='active' WHERE id=$1", [
      account.id,
    ]);
    const response = await fetch(`${server.url}/api/me`, {
      headers: { cookie: `sid=${account.token}` },
    });
    expect(response.ok).toBe(true);
    const deleted = await fetch(`${server.url}/api/me`, {
      method: 'DELETE',
      headers: {
        'content-type': 'application/json',
        origin: server.url,
        cookie: `sid=${account.token}`,
      },
      body: JSON.stringify({
        password: 'e2e-proof-password-2026',
        confirmation: 'DELETE MY ACCOUNT',
      }),
    });
    expect(deleted.ok).toBe(true);
    const result = await runSweep(proofDb, { store: new LocalObjectStore() });
    expect(result?.accounts).toMatchObject({ deleted: 1, failed: 0 });
    expect(
      (await proofDb.query('SELECT 1 FROM accounts WHERE id=$1', [account.id]))
        .rowCount,
    ).toBe(0);
    expect(await accountPiiReferences(account.id, account.email)).toEqual([]);
  } finally {
    await server.stop();
  }
});
