// Boots the built server (dist/main.js) with NODE_ENV=production against a scratch Postgres,
// a stub OpenAI-compatible endpoint, and generated dummy secrets. Exits non-zero on any failure.
// Usage: DATABASE_URL=postgres://... pnpm --filter @game/server smoke:prod   (after `pnpm -r build`)
import { spawn, execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { createServer as netServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hash } from '@node-rs/argon2';
import pg from 'pg';
import WebSocket from 'ws';

const serverDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const databaseUrl = process.env.DATABASE_URL;

const secrets = {
  ageRetry: randomBytes(32).toString('base64url'),
  masterKey: randomBytes(32).toString('hex'),
  resend: 're_smoke_not_a_real_key',
  llm: 'smoke-dummy-llm-key',
};
const redact = (text) =>
  Object.values(secrets).reduce(
    (out, value) => out.split(value).join('[REDACTED]'),
    String(text),
  );
const playerPassword = randomBytes(12).toString('base64url');
const operatorPassword = randomBytes(12).toString('base64url');
const suffix = randomUUID().slice(0, 8);
const playerEmail = `smoke-player-${suffix}@smoke.invalid`;
const operatorEmail = `smoke-operator-${suffix}@smoke.invalid`;
const exportDir = mkdtempSync(join(tmpdir(), 'lorekeep-smoke-exports-'));

function fail(message) {
  console.error(`SMOKE FAIL: ${redact(message)}`);
  process.exit(1);
}

if (!databaseUrl)
  fail('DATABASE_URL must point at a scratch Postgres database');
if (!existsSync(join(serverDir, 'dist/main.js')))
  fail('dist/main.js missing: run `pnpm -r build` first');

const freePort = () =>
  new Promise((resolve, reject) => {
    const probe = netServer().listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
    probe.on('error', reject);
  });

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitUntil(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(100);
  }
  throw new Error(`timed out waiting for ${label}`);
}

// Stub OpenAI-compatible endpoint: streams one text completion and records each request.
function startStub() {
  const requests = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
        res.writeHead(404).end();
        return;
      }
      const parsed = JSON.parse(body || '{}');
      requests.push({ auth: req.headers.authorization, model: parsed.model });
      const chunk = (delta, extra = {}) =>
        `data: ${JSON.stringify({ id: 'smoke', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: null }], ...extra })}\n\n`;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(chunk({ role: 'assistant', content: 'The crypt is quiet.' }));
      res.write(
        `data: ${JSON.stringify({ id: 'smoke', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`,
      );
      res.end('data: [DONE]\n\n');
    });
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({
        port: server.address().port,
        requests,
        close: () => server.close(),
      }),
    ),
  );
}

const cookieFrom = (setCookie) => {
  const first = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  return first?.split(';')[0];
};

async function main() {
  console.log('smoke: migrating scratch database');
  execFileSync('pnpm', ['run', 'migrate:up'], {
    cwd: serverDir,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: 'ignore',
  });

  const db = new pg.Pool({ connectionString: databaseUrl });
  const stub = await startStub();
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const base = origin;

  const insertAccount = (email, password, display) =>
    hash(password).then((passwordHash) =>
      db.query(
        `INSERT INTO accounts(id,email,password_hash,display_name,status,is_adult,age_checked_at,terms_version,terms_accepted_at)
         VALUES($1,$2,$3,$4,'active',true,now(),'v1',now()) RETURNING id`,
        [randomUUID(), email, passwordHash, display],
      ),
    );
  await insertAccount(playerEmail, playerPassword, 'Smoke Player');
  await insertAccount(operatorEmail, operatorPassword, 'Smoke Operator');

  const child = spawn(process.execPath, ['dist/main.js'], {
    cwd: serverDir,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      NODE_ENV: 'production',
      DATABASE_URL: databaseUrl,
      HOST: '127.0.0.1',
      PORT: String(port),
      TRUST_PROXY: 'true',
      AGE_RETRY_SECRET: secrets.ageRetry,
      OPERATOR_EMAILS: operatorEmail,
      OPERATOR_ENDPOINT_MASTER_KEY: secrets.masterKey,
      RESEND_API_KEY: secrets.resend,
      EMAIL_FROM: 'Lorekeep Smoke <noreply@smoke.invalid>',
      APP_BASE_URL: 'https://app.smoke.invalid',
      LLM_ALLOW_LOCAL_HOSTS: `127.0.0.1:${stub.port}`,
      EXPORT_ARCHIVE_DIR: exportDir,
      SWEEP_INTERVAL_MS: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  child.stdout.on('data', (d) => (serverLog += d));
  child.stderr.on('data', (d) => (serverLog += d));
  const exited = new Promise((resolve) =>
    child.once('exit', (code) => resolve(code)),
  );
  let exitedEarly = false;
  child.once('exit', () => (exitedEarly = true));

  const cleanup = async () => {
    if (!exitedEarly) {
      child.kill('SIGINT');
      await Promise.race([exited, delay(15_000)]);
      if (!exitedEarly) child.kill('SIGKILL');
    }
    stub.close();
    await db.end();
    rmSync(exportDir, { recursive: true, force: true });
  };

  const json = async (res) => res.json().catch(() => ({}));
  const login = (email, password, xff, extra = {}) =>
    fetch(`${base}/api/login`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': xff,
        ...extra,
      },
      body: JSON.stringify({ email, password }),
    });

  let ws;
  try {
    await waitUntil(
      async () => {
        if (exitedEarly)
          throw new Error(`server exited early:\n${serverLog.slice(-2000)}`);
        return (
          (await fetch(`${base}/healthz`).catch(() => null))?.status === 200
        );
      },
      30_000,
      'server /healthz',
    );
    console.log('ok: production boot serves /healthz');

    const ready = await fetch(`${base}/readyz`);
    if (ready.status !== 200)
      throw new Error(`/readyz returned ${ready.status}`);
    console.log('ok: /readyz reaches Postgres');

    // Login behind the proxy: __Host- cookie, Secure, HttpOnly.
    const playerLogin = await login(
      playerEmail,
      playerPassword,
      '198.51.100.10',
      {
        'x-forwarded-proto': 'https',
      },
    );
    if (playerLogin.status !== 200)
      throw new Error(`player login returned ${playerLogin.status}`);
    const setCookie = playerLogin.headers.get('set-cookie') ?? '';
    if (!setCookie.startsWith('__Host-sid='))
      throw new Error(
        `cookie missing __Host- prefix: ${setCookie.split('=')[0]}`,
      );
    if (!/;\s*Secure/i.test(setCookie))
      throw new Error('session cookie missing Secure');
    if (!/;\s*HttpOnly/i.test(setCookie))
      throw new Error('session cookie missing HttpOnly');
    console.log(
      'ok: login Set-Cookie is __Host-sid, Secure, HttpOnly with X-Forwarded-Proto: https',
    );

    // Rate-limit buckets follow the forwarded client address.
    for (let i = 0; i < 5; i++) {
      const res = await login(
        playerEmail,
        'wrong-password-smoke',
        '203.0.113.7',
      );
      if (res.status !== 401)
        throw new Error(
          `failed login ${i + 1} from 203.0.113.7 returned ${res.status}`,
        );
    }
    const limited = await login(
      playerEmail,
      'wrong-password-smoke',
      '203.0.113.7',
    );
    if (limited.status !== 429)
      throw new Error(
        `6th failed login from 203.0.113.7 returned ${limited.status}, expected 429`,
      );
    const otherClient = await login(
      playerEmail,
      'wrong-password-smoke',
      '203.0.113.8',
    );
    if (otherClient.status !== 401)
      throw new Error(
        `203.0.113.8 shares 203.0.113.7's bucket (returned ${otherClient.status})`,
      );
    console.log(
      'ok: two X-Forwarded-For addresses get separate rate-limit buckets',
    );

    // Point the moderate slot at the stub, then play one solo turn.
    const opLogin = await login(
      operatorEmail,
      operatorPassword,
      '198.51.100.20',
      {
        'x-forwarded-proto': 'https',
      },
    );
    if (opLogin.status !== 200)
      throw new Error(`operator login returned ${opLogin.status}`);
    const opCookie = cookieFrom(opLogin.headers.get('set-cookie'));
    const put = await fetch(`${base}/api/operator/endpoints/moderate`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', cookie: opCookie },
      body: JSON.stringify({
        baseUrl: `http://127.0.0.1:${stub.port}/v1`,
        model: 'smoke-model',
        apiStyle: 'openai',
        apiKey: secrets.llm,
        contextWindow: 32768,
      }),
    });
    if (put.status !== 200)
      throw new Error(
        `operator endpoint PUT returned ${put.status}: ${await put.text()}`,
      );

    // Live DM turns are operator-allowlisted until M3 moderation lands (LIVE_DM_ALLOWLIST_ONLY).
    const created = await fetch(`${base}/api/tables`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: opCookie },
      body: JSON.stringify({
        name: 'Smoke Crypt',
        adventureId: 'adventure:01-hollow-under-marrowfell',
        difficulty: 'moderate',
        startingLevel: 1,
      }),
    });
    if (created.status !== 201)
      throw new Error(`table create returned ${created.status}`);
    const sessionId = (await json(created)).game.id;

    const ticketRes = await fetch(`${base}/api/ws-ticket`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin,
        cookie: opCookie,
      },
      body: JSON.stringify({ sessionId }),
    });
    if (ticketRes.status !== 200)
      throw new Error(`ws-ticket returned ${ticketRes.status}`);
    const { ticket } = await json(ticketRes);

    const messages = [];
    ws = new WebSocket(
      `${base.replace(/^http/, 'ws')}/ws?sessionId=${sessionId}&ticket=${ticket}`,
      {
        headers: { origin },
      },
    );
    ws.on('message', (data) => messages.push(JSON.parse(String(data))));
    await new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });
    await waitUntil(
      () => messages.some((m) => m.type === 'StateSync'),
      10_000,
      'initial StateSync',
    );
    const lastSeq = Math.max(...messages.map((m) => m.seq ?? 0));
    ws.send(
      JSON.stringify({
        actionId: randomUUID(),
        type: 'PlayerAction',
        payload: { text: 'I look around the crypt.' },
        lastSeq,
      }),
    );
    await waitUntil(
      () => stub.requests.length > 0,
      45_000,
      'solo turn to reach the stub endpoint',
    );
    const hit = stub.requests[0];
    if (hit.auth !== `Bearer ${secrets.llm}`)
      throw new Error(
        'stub endpoint did not receive the configured bearer key',
      );
    if (hit.model !== 'smoke-model')
      throw new Error(`stub received model ${hit.model}`);
    console.log(
      'ok: one solo turn reached the stub endpoint with the configured key and model',
    );

    const narrated = messages.some(
      (m) => m.type === 'NarrationChunk' || m.type === 'NarrationCompleted',
    );
    console.log(`info: narration received over websocket: ${narrated}`);

    ws.close();
    ws = undefined;
    const exitCode = await Promise.race([
      cleanup().then(() => 'done'),
      delay(20_000).then(() => 'timeout'),
    ]);
    if (exitCode !== 'done') throw new Error('cleanup timed out');
    console.log(
      'SMOKE PASS: production boot, cookie, rate-limit buckets, and solo turn to stub all verified',
    );
  } catch (error) {
    ws?.close();
    await cleanup();
    fail(
      `${error.message}\n--- server log tail ---\n${serverLog.slice(-3000)}`,
    );
  }
}

main().catch((error) => fail(error.stack ?? error.message));
