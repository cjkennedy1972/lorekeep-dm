import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import {
  LiveDmRestrictedError,
  type SoloTurnRequest,
} from '../../src/room/dmTurn.js';
import { ProductionSoloTurnRunner } from '../../src/room/productionTurnRunner.js';

const OPERATOR = 'Operator@Example.test';
const accounts: Record<string, { email: string; status: string }> = {
  'acct-operator': { email: OPERATOR, status: 'active' },
  'acct-pending-operator': { email: OPERATOR, status: 'pending_email' },
  'acct-player': { email: 'player@example.test', status: 'active' },
};
const db = {
  async query(sql: string, params: unknown[] = []) {
    if (!sql.includes('FROM accounts')) return { rows: [] };
    const account = accounts[params[0] as string];
    const active = account?.status === 'active';
    return { rows: active ? [{ email: account.email }] : [] };
  },
} as never;

const request = (accountId: string): SoloTurnRequest => ({
  sessionId: 'session',
  accountId,
  actionId: 'action',
  text: 'I look around.',
  state: {},
});

async function restricted(
  runner: ProductionSoloTurnRunner,
  accountId: string,
): Promise<boolean> {
  return runner
    .run(request(accountId), () => undefined)
    .then(
      () => false,
      (error: unknown) => error instanceof LiveDmRestrictedError,
    );
}

const liveRunner = (fixtureMode?: 'strict', allowlistOnly = true) =>
  new ProductionSoloTurnRunner(
    db,
    undefined,
    fixtureMode,
    undefined,
    undefined,
    allowlistOnly,
  );

describe('live DM allowlist gate', () => {
  const saved = { ...process.env };
  beforeEach(() => {
    process.env.NODE_ENV = 'production';
    process.env.OPERATOR_EMAILS = OPERATOR;
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  it('restricts a non-allowlisted account from starting a live turn', async () => {
    expect(await restricted(liveRunner(), 'acct-player')).toBe(true);
  });

  it('lets an allowlisted operator account start a live turn, case-insensitively', async () => {
    expect(await restricted(liveRunner(), 'acct-operator')).toBe(false);
  });

  it('restricts an allowlisted address whose account is not active', async () => {
    expect(await restricted(liveRunner(), 'acct-pending-operator')).toBe(true);
  });

  it('allows every account when the flag is off', async () => {
    expect(await restricted(liveRunner(undefined, false), 'acct-player')).toBe(
      false,
    );
  });

  it('leaves recorded fixture mode unaffected', async () => {
    expect(await restricted(liveRunner('strict'), 'acct-player')).toBe(false);
  });

  it('leaves NODE_ENV=test unaffected', async () => {
    process.env.NODE_ENV = 'test';
    expect(await restricted(liveRunner(), 'acct-player')).toBe(false);
  });

  it('evaluates the allowlist on every turn', async () => {
    const runner = liveRunner();
    expect(await restricted(runner, 'acct-player')).toBe(true);
    process.env.OPERATOR_EMAILS = `${OPERATOR},player@example.test`;
    expect(await restricted(runner, 'acct-player')).toBe(false);
  });
});

describe('LIVE_DM_ALLOWLIST_ONLY config', () => {
  const base = { DATABASE_URL: 'postgres://localhost/test' };
  it('defaults to on', () => {
    expect(loadConfig(base).LIVE_DM_ALLOWLIST_ONLY).toBe(true);
  });
  it('turns off only on an explicit false', () => {
    expect(
      loadConfig({ ...base, LIVE_DM_ALLOWLIST_ONLY: 'false' })
        .LIVE_DM_ALLOWLIST_ONLY,
    ).toBe(false);
    expect(() =>
      loadConfig({ ...base, LIVE_DM_ALLOWLIST_ONLY: 'off' }),
    ).toThrow('LIVE_DM_ALLOWLIST_ONLY');
  });
});
