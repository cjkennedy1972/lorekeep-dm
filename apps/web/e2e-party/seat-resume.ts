import type { BrowserContext } from '@playwright/test';

/**
 * Test-only. Call before a seated account's first open in a spec file, after its sid cookie is set.
 * The fixture seats tables at server boot, and the server's one-time resume token expires 30 s
 * later, so an open that comes after that window would wait on host approval forever.
 */
export async function mintSeatResume(
  context: BrowserContext,
  origin: string,
  table: string,
  account: { accountId: string; token: string },
): Promise<number> {
  const response = await context.request.post(
    `${origin}/api/test/mint-seat-resume`,
    {
      data: {
        table,
        accountId: account.accountId,
        token: account.token,
      },
    },
  );
  // An unseated account (a late joiner awaiting admission) has no seat to mint a token for.
  if (response.status() === 404) return 404;
  if (!response.ok())
    throw new Error(`mint-seat-resume failed: ${response.status()}`);
  return response.status();
}
