import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { Pool } from 'pg';
import { afterAll } from 'vitest';

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl)
  throw new Error('DATABASE_URL is required for real-server e2e proof');
const admin = new Pool({ connectionString: baseUrl });
const schema = `proof_${randomBytes(10).toString('hex')}`;
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
await admin.query(`CREATE DATABASE "${schema}"`);
await admin.query('CREATE EXTENSION IF NOT EXISTS citext WITH SCHEMA public');
const dbUrl = new URL(baseUrl);
dbUrl.pathname = `/${schema}`;
export const proofDb = new Pool({ connectionString: dbUrl.toString() });
export const proofSchema = 'public';
export const apiOrigin = 'http://127.0.0.1';

// Apply the checked-in migrations within this test's isolated schema.
for (const file of [
  '0001_game_core.sql',
  '0002_accounts.sql',
  '0003_lease_epoch.sql',
  '0004_room_invites.sql',
  '0005_ws_ticket_auth_session.sql',
  '0006_retention.sql',
]) {
  const { readFile } = await import('node:fs/promises');
  const sql = await readFile(
    new URL(`../../apps/server/migrations/${file}`, import.meta.url),
    'utf8',
  );
  await proofDb.query(sql);
}

const processes = new Set<ChildProcess>();
afterAll(async () => {
  await Promise.all(
    [...processes].map(async (child) => {
      if (child.exitCode !== null) return;
      child.kill('SIGKILL');
      await once(child, 'exit');
    }),
  );
  await proofDb.end();
  await admin.query(`DROP DATABASE "${schema}" WITH (FORCE)`);
  await admin.end();
});

let portCounter = 34000 + Math.floor(Math.random() * 20000);
export interface RunningServer {
  child: ChildProcess;
  url: string;
  stop(signal?: NodeJS.Signals): Promise<void>;
}

export async function startServer(): Promise<RunningServer> {
  const port = portCounter++;
  const child = spawn(process.execPath, ['apps/server/dist/main.js'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      DATABASE_URL: dbUrl.toString(),
      HOST: '127.0.0.1',
      PORT: String(port),
      NODE_ENV: 'test',
      AGE_RETRY_SECRET: 'e2e-proof-only-secret',
      SWEEP_INTERVAL_MS: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  processes.add(child);
  let output = '';
  child.stdout?.on('data', (chunk: Buffer) => (output += chunk.toString()));
  child.stderr?.on('data', (chunk: Buffer) => (output += chunk.toString()));
  const url = `${apiOrigin}:${port}`;
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null)
      throw new Error(
        `Server exited before readiness (${child.exitCode}): ${output}`,
      );
    try {
      if ((await fetch(`${url}/readyz`)).ok) break;
    } catch {
      // The listener is not ready yet.
    }
    await delay(50);
  }
  if (Date.now() >= deadline)
    throw new Error(`Server readiness timed out: ${output}`);
  return {
    child,
    url,
    async stop(signal = 'SIGTERM') {
      if (child.exitCode !== null) return;
      const stopStarted = Date.now();
      child.kill(signal);
      const timeout = delay(8_000).then(() => {
        if (child.exitCode === null) child.kill('SIGKILL');
      });
      await Promise.race([once(child, 'exit'), timeout]);
      if (signal === 'SIGTERM' && child.exitCode !== 0)
        throw new Error(
          `SIGTERM shutdown exited ${child.exitCode} after ${Date.now() - stopStarted}ms: ${output}`,
        );
    },
  };
}

export interface Account {
  id: string;
  email: string;
  token: string;
}
const password = 'e2e-proof-password-2026';
export async function createVerifiedAccount(url: string): Promise<Account> {
  const email = `${randomUUID()}@example.test`;
  const signup = await fetch(`${url}/api/signup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: url },
    body: JSON.stringify({
      email,
      password,
      displayName: `Proof ${email.slice(0, 8)}`,
      birthdate: '1990-01-01',
      termsVersion: 'm0-proof',
    }),
  });
  if (signup.status !== 202)
    throw new Error(`Signup failed: ${signup.status} ${await signup.text()}`);
  const row = (
    await proofDb.query<{ id: string; token_hash: string }>(
      "SELECT a.id,t.token_hash FROM accounts a JOIN email_tokens t ON t.account_id=a.id WHERE a.email=$1 AND t.kind='verify'",
      [email],
    )
  ).rows[0];
  if (!row)
    throw new Error('Signup did not create account and verification token');
  // The dev mailer intentionally does not expose tokens; generate and use one through the same token hash contract.
  const hashToken = (token: string) =>
    createHash('sha256').update(token).digest('hex');
  const verifyToken = randomBytes(32).toString('base64url');
  await proofDb.query(
    'UPDATE email_tokens SET token_hash=$2 WHERE token_hash=$1',
    [row.token_hash, hashToken(verifyToken)],
  );
  const verified = await fetch(`${url}/api/verify-email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: url },
    body: JSON.stringify({ token: verifyToken }),
  });
  if (!verified.ok) throw new Error(`Verification failed: ${verified.status}`);
  const login = await fetch(`${url}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: url },
    body: JSON.stringify({ email, password }),
  });
  if (!login.ok)
    throw new Error(`Login failed: ${login.status} ${await login.text()}`);
  const cookie = login.headers.get('set-cookie');
  const token = cookie?.match(/(?:^|;\s*)sid=([^;]+)/)?.[1];
  if (!token) throw new Error('Login response omitted session cookie');
  return { id: row.id, email, token };
}

export async function createRoom(url: string, account: Account) {
  const response = await fetch(`${url}/api/rooms`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: url,
      cookie: `sid=${account.token}`,
    },
    body: JSON.stringify({ name: 'M0 proof room' }),
  });
  if (!response.ok)
    throw new Error(
      `Create room failed: ${response.status} ${await response.text()}`,
    );
  return ((await response.json()) as { room: { id: string; code: string } })
    .room;
}

export async function joinRoom(url: string, code: string, account: Account) {
  const response = await fetch(`${url}/api/join/${encodeURIComponent(code)}`, {
    method: 'POST',
    headers: { origin: url, cookie: `sid=${account.token}` },
  });
  if (!response.ok)
    throw new Error(
      `Join room failed: ${response.status} ${await response.text()}`,
    );
}

export async function connectRoom(
  url: string,
  roomId: string,
  account: Account,
  lastSeq?: number,
) {
  const ticketResponse = await fetch(`${url}/api/ws-ticket`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: url,
      cookie: `sid=${account.token}`,
    },
    body: JSON.stringify({ sessionId: roomId }),
  });
  if (!ticketResponse.ok)
    throw new Error(`Ticket request failed: ${ticketResponse.status}`);
  const { ticket } = (await ticketResponse.json()) as { ticket: string };
  const socketUrl =
    url.replace(/^http/, 'ws') + `/ws?sessionId=${roomId}&ticket=${ticket}`;
  const socket = new WebSocket(socketUrl, {
    headers: { origin: url },
  } as never);
  const messages: Record<string, unknown>[] = [];
  socket.addEventListener('message', (event) =>
    messages.push(JSON.parse(String(event.data)) as Record<string, unknown>),
  );
  await Promise.race([
    new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => resolve(), { once: true });
      socket.addEventListener(
        'error',
        () => reject(new Error('WebSocket connection failed')),
        { once: true },
      );
    }),
    delay(5_000).then(() => {
      throw new Error('WebSocket open timed out');
    }),
  ]);
  if (lastSeq !== undefined)
    socket.send(
      JSON.stringify({
        actionId: randomUUID(),
        type: 'Resync',
        payload: {},
        lastSeq,
      }),
    );
  return {
    socket,
    messages,
    async waitFor(
      predicate: (message: Record<string, unknown>) => boolean,
      timeoutMs = 3_000,
    ) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const found = messages.find(predicate);
        if (found) return found;
        await delay(20);
      }
      throw new Error(
        `Expected websocket message not observed; messages=${JSON.stringify(messages)}`,
      );
    },
    async close() {
      if (socket.readyState === WebSocket.CLOSED) return;
      socket.close();
      await Promise.race([once(socket, 'close'), delay(2_000)]);
    },
  };
}

export async function accountPiiReferences(accountId: string, email: string) {
  const tables = (
    await proofDb.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'`,
    )
  ).rows;
  const matches: string[] = [];
  for (const { table_name } of tables) {
    const columns = (
      await proofDb.query<{
        column_name: string;
        data_type: string;
        udt_name: string;
      }>(
        `SELECT column_name,data_type,udt_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1`,
        [table_name],
      )
    ).rows;
    for (const col of columns) {
      const values =
        col.data_type === 'uuid'
          ? [accountId]
          : ['text', 'character varying', 'character'].includes(
                col.data_type,
              ) || col.udt_name === 'citext'
            ? [accountId, email]
            : col.data_type === 'jsonb'
              ? [accountId, email]
              : [];
      for (const value of values) {
        const result = await proofDb.query(
          `SELECT 1 FROM public."${table_name}" WHERE "${col.column_name}"::text ILIKE $1 LIMIT 1`,
          [`%${value}%`],
        );
        if (result.rowCount) matches.push(`${table_name}.${col.column_name}`);
      }
    }
  }
  return matches;
}

export const proofEmail = (prefix: string) =>
  `${prefix}-${randomUUID()}@example.test`;
