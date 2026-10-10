import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type Browser, type Page } from '@playwright/test';

const root = resolve(process.cwd(), '../..');
const stateFile = process.env.LIVE_STATE_FILE!;
const apiPort = Number(process.env.LIVE_API_PORT ?? 8799);
const apiOrigin = `http://127.0.0.1:${apiPort}`;
const bootFile = `${stateFile}.boot`;
const adventureId = 'adventure:01-hollow-under-marrowfell';
const sceneIds = [
  'scene-marowfell-well',
  'scene-broken-gatehouse',
  'scene-chapel-of-wicks',
  'scene-warren-gallery',
  'scene-tallow-larder',
  'scene-boss-hall',
  'scene-winch-shaft',
  'scene-lamp-vault',
];

type Seed = { token: string; accountId: string };
type QueryResult<T> = { rows: T[] };
type TestPool = {
  query<T>(sql: string, values?: unknown[]): Promise<QueryResult<T>>;
  end(): Promise<void>;
};
const requireFromRoot = createRequire(resolve(root, 'package.json'));
const requireFromServer = createRequire(
  resolve(root, 'apps/server/package.json'),
);
const { Pool } = requireFromServer('pg') as {
  Pool: new (config: { connectionString: string }) => TestPool;
};
const vitestEntrypoint = requireFromRoot.resolve('vitest/vitest.mjs') as string;

let server: ChildProcess | undefined;
let pool: TestPool | undefined;
let tableId: string | undefined;

async function startServer() {
  const bootToken = randomUUID();
  server = spawn(
    process.execPath,
    [
      vitestEntrypoint,
      'run',
      '-c',
      'apps/server/test/live/vitest.adventure.live.config.ts',
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        LIVE_STATE_FILE: stateFile,
        LIVE_API_PORT: String(apiPort),
        LIVE_BOOT_TOKEN: bootToken,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    },
  );
  let output = '';
  server.stdout?.on('data', (data: Buffer) => (output += data.toString()));
  server.stderr?.on('data', (data: Buffer) => (output += data.toString()));
  const child = server;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null)
      throw new Error(
        `Adventure server exited early (${child.exitCode}):\n${output}`,
      );
    try {
      if (
        !existsSync(bootFile) ||
        readFileSync(bootFile, 'utf8') !== bootToken
      ) {
        await new Promise((resolveWait) => setTimeout(resolveWait, 100));
        continue;
      }
      const response = await fetch(`${apiOrigin}/api/me`);
      if (response.status < 500 && existsSync(stateFile)) return;
    } catch {
      // The process is still binding the port.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`Adventure server did not become ready:\n${output}`);
}

async function stopServer() {
  const child = server;
  if (!child || child.exitCode !== null) return;
  await new Promise<void>((resolveExit, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Adventure server did not stop on SIGTERM')),
      15_000,
    );
    child.once('exit', () => {
      clearTimeout(timer);
      resolveExit();
    });
    if (child.pid) process.kill(-child.pid, 'SIGTERM');
  });
  server = undefined;
}

async function authenticate(browser: Browser, token: string) {
  const context = await browser.newContext();
  await context.addCookies([
    { name: 'sid', value: token, url: 'http://localhost:5175' },
  ]);
  return context;
}

async function keyboardActivate(
  page: Page,
  locator: ReturnType<Page['getByRole']>,
) {
  await locator.focus();
  await expect(locator).toBeFocused();
  await page.keyboard.press('Enter');
}

async function submitAdvance(page: Page, marker: string) {
  const send = page.getByRole('button', { name: 'Send action' });
  const pending = page.locator('.action-input__pending');
  await expect(pending).toHaveCount(0);
  const action = page.getByLabel('Your action');
  await action.focus();
  await page.keyboard.type(marker);
  await expect(send).toBeEnabled();
  await page.keyboard.press('Tab');
  await expect(send).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(
    page.getByRole('region', { name: 'Narration log' }),
  ).toContainText(marker, {
    timeout: 30_000,
  });
  await expect(pending).toHaveCount(0, { timeout: 30_000 });
}

async function gameState(id: string) {
  for (let attempt = 0; attempt < 60; attempt++) {
    const result = await pool!.query<{
      state: { gameState?: Record<string, unknown> };
    }>(
      'SELECT state FROM snapshots WHERE session_id=$1 ORDER BY seq DESC LIMIT 1',
      [id],
    );
    const game = result.rows[0]?.state.gameState;
    if (game) return game;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`No persisted game state for ${id}`);
}

async function purgeOwnedSessions(accountId: string) {
  const sessions = await pool!.query<{ id: string }>(
    'SELECT id FROM sessions WHERE owner_account_id=$1',
    [accountId],
  );
  for (const session of sessions.rows)
    await pool!.query('SELECT purge_session($1)', [session.id]);
}

async function expectScene(id: string, sceneId: string, completed = false) {
  let latest: Record<string, unknown> | undefined;
  for (let attempt = 0; attempt < 60; attempt++) {
    latest = await gameState(id);
    if (latest.sceneId === sceneId && latest.adventureCompleted === completed)
      return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  expect(latest).toMatchObject({ sceneId, adventureCompleted: completed });
}

test('keyboard-only Adventure #1 starts through the solo flow, restarts mid-scene, resumes, and completes', async ({
  browser,
}) => {
  test.setTimeout(240_000);
  pool = new Pool({ connectionString: process.env.DATABASE_URL! });
  let context: Awaited<ReturnType<typeof authenticate>> | undefined;
  try {
    await startServer();
    const seed = JSON.parse(readFileSync(stateFile, 'utf8')) as Seed;
    await purgeOwnedSessions(seed.accountId);
    context = await authenticate(browser, seed.token);
    const page = await context.newPage();
    await page.goto('/');
    await keyboardActivate(
      page,
      page.getByRole('link', { name: 'Start a solo game' }),
    );
    await page.getByLabel('Game name').focus();
    await page.keyboard.type('Adventure Resume Proof');
    const createdResponsePromise = page.waitForResponse(
      (response) =>
        response.url().includes('/api/tables') &&
        response.request().method() === 'POST',
    );
    await keyboardActivate(
      page,
      page.getByRole('button', { name: 'Create solo game' }),
    );
    const createdResponse = await createdResponsePromise;
    expect(createdResponse.status()).toBe(201);
    const created = (await createdResponse.json()) as {
      game: { id: string; adventureId: string };
    };
    tableId = created.game.id;
    expect(created.game.adventureId).toBe(adventureId);
    await expect(page.getByLabel('Your action')).toBeVisible();

    for (let index = 0; index < 3; index++) {
      await submitAdvance(page, `ADVANCE-${index + 1}`);
      await expectScene(tableId, sceneIds[index + 1]!);
    }
    expect(await gameState(tableId)).toMatchObject({
      sceneId: 'scene-warren-gallery',
    });
    await context.close();
    context = undefined;
    await stopServer();
    await startServer();

    context = await authenticate(browser, seed.token);
    const resumed = await context.newPage();
    await resumed.goto('/rooms');
    await expect(
      resumed.getByRole('heading', { name: 'My games' }),
    ).toBeVisible();
    await keyboardActivate(
      resumed,
      resumed.getByRole('link', { name: 'Resume Adventure Resume Proof' }),
    );
    await expect(resumed.getByLabel('Your action')).toBeVisible({
      timeout: 30_000,
    });
    await expect(
      resumed.getByRole('region', { name: 'Previously on' }),
    ).toContainText('ADVANCE-3');
    await expectScene(tableId, 'scene-warren-gallery');

    for (let index = 3; index < sceneIds.length; index++) {
      await submitAdvance(resumed, `ADVANCE-${index + 1}`);
      const terminal = index === sceneIds.length - 1;
      await expectScene(
        tableId,
        sceneIds[Math.min(index + 1, sceneIds.length - 1)]!,
        terminal,
      );
    }
    expect(await gameState(tableId)).toMatchObject({
      sceneId: 'scene-lamp-vault',
      adventureCompleted: true,
    });
    // There is no adventure-completion UI state yet; completion is asserted from the persisted room snapshot.
  } finally {
    await context?.close();
    await stopServer();
    if (pool) {
      if (existsSync(stateFile)) {
        const seed = JSON.parse(readFileSync(stateFile, 'utf8')) as Seed;
        await purgeOwnedSessions(seed.accountId);
        await pool.query('DELETE FROM auth_sessions WHERE account_id=$1', [
          seed.accountId,
        ]);
        await pool.query('DELETE FROM accounts WHERE id=$1', [seed.accountId]);
      }
      await pool.end();
      pool = undefined;
    }
    rmSync(stateFile, { force: true });
    rmSync(`${stateFile}.ndjson`, { force: true });
    rmSync(bootFile, { force: true });
  }
});
