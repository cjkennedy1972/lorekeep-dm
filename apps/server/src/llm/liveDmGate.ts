import type { Pool } from 'pg';
import { isOperatorAccount } from './config.js';
import type { FixtureMode } from './recorded.js';

/** Whether this account may trigger a live (non-replay) model call. Every live call site uses this rule. */
export async function liveDmAllowed(
  db: Pick<Pool, 'query'>,
  accountId: string,
  allowlistOnly: boolean,
  fixtureMode: FixtureMode | undefined,
): Promise<boolean> {
  if (!allowlistOnly || fixtureMode || process.env.NODE_ENV === 'test')
    return true;
  return isOperatorAccount(db, accountId);
}
