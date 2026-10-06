import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import {
  AccountIdSchema,
  LoginInputSchema,
  SignupInputSchema,
  type Account,
} from '@game/schema';
import { Room } from './room.js';

// The contract has no HTTP error schema yet; reuse the WS Error payload shape {code, message}.
const MIN_AGE = 18;

function ageOn(birthdate: string, now: Date): number {
  const [y, m, d] = birthdate.split('-').map(Number) as [
    number,
    number,
    number,
  ];
  let age = now.getUTCFullYear() - y;
  if (
    now.getUTCMonth() + 1 < m ||
    (now.getUTCMonth() + 1 === m && now.getUTCDate() < d)
  )
    age--;
  return age;
}

export function createMock(opts: { scriptedFlipMs?: number } = {}) {
  const room = new Room(opts.scriptedFlipMs);
  const users = new Map<string, { account: Account; password: string }>(); // by email
  const sessions = new Map<string, string>(); // token -> accountId
  const tickets = new Map<string, string>(); // ticket -> accountId (single use)
  const byId = (id: string) =>
    [...users.values()].find((u) => u.account.id === id)?.account;

  const json = (
    res: ServerResponse,
    status: number,
    body: unknown,
    headers: Record<string, string> = {},
  ) => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(JSON.stringify(body));
  };
  const err = (
    res: ServerResponse,
    status: number,
    code: string,
    message: string,
  ) => json(res, status, { code, message });
  const readBody = async (req: IncomingMessage) => {
    let s = '';
    for await (const c of req) s += c;
    try {
      return s ? JSON.parse(s) : {};
    } catch {
      return undefined;
    }
  };
  const authed = (req: IncomingMessage) => {
    const token = /(?:^|; )sid=([^;]+)/.exec(req.headers.cookie ?? '')?.[1];
    const id = token && sessions.get(token);
    return id ? byId(id) : undefined;
  };
  const login = (res: ServerResponse, account: Account) => {
    const token = crypto.randomUUID();
    sessions.set(token, account.id);
    return { 'set-cookie': `sid=${token}; Path=/; HttpOnly; SameSite=Lax` };
  };

  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://mock');
    const route = `${req.method} ${url.pathname}`;
    // Dev-only CORS reflect so a Vite dev server on another port can call the mock.
    if (req.headers.origin) {
      res.setHeader('access-control-allow-origin', req.headers.origin);
      res.setHeader('access-control-allow-credentials', 'true');
      res.setHeader('access-control-allow-headers', 'content-type');
      res.setHeader('access-control-allow-methods', 'GET,POST,DELETE,OPTIONS');
    }
    if (req.method === 'OPTIONS') return void res.writeHead(204).end();

    if (route === 'POST /api/signup') {
      const parsed = SignupInputSchema.safeParse(await readBody(req));
      if (!parsed.success)
        return err(
          res,
          400,
          'INVALID_INPUT',
          parsed.error.issues[0]?.message ?? 'Invalid input',
        );
      const { email, password, displayName, birthdate } = parsed.data;
      if (ageOn(birthdate, new Date()) < MIN_AGE)
        return err(
          res,
          403,
          'UNDERAGE',
          'You must be 18 or older to create an account.',
        );
      if (users.has(email))
        return err(
          res,
          409,
          'EMAIL_TAKEN',
          'An account with that email already exists.',
        );
      const account: Account = {
        id: AccountIdSchema.parse(crypto.randomUUID()),
        email,
        displayName,
        isAdult: true,
        ageCheckedAt: new Date().toISOString(),
      };
      users.set(email, { account, password });
      return json(res, 201, { account }, login(res, account));
    }
    if (route === 'POST /api/login') {
      const parsed = LoginInputSchema.safeParse(await readBody(req));
      if (!parsed.success)
        return err(
          res,
          400,
          'INVALID_INPUT',
          parsed.error.issues[0]?.message ?? 'Invalid input',
        );
      const u = users.get(parsed.data.email);
      if (!u || u.password !== parsed.data.password)
        return err(
          res,
          401,
          'BAD_CREDENTIALS',
          'Email or password is incorrect.',
        );
      return json(res, 200, { account: u.account }, login(res, u.account));
    }
    if (route === 'POST /api/logout') {
      const token = /(?:^|; )sid=([^;]+)/.exec(req.headers.cookie ?? '')?.[1];
      if (token) sessions.delete(token);
      return json(res, 200, {}, { 'set-cookie': 'sid=; Path=/; Max-Age=0' });
    }

    const account = authed(req);
    if (url.pathname.startsWith('/api/') && !account)
      return err(res, 401, 'UNAUTHENTICATED', 'Sign in required.');
    if (!account) return err(res, 404, 'NOT_FOUND', 'Not found.');

    if (route === 'GET /api/me') return json(res, 200, { account });
    if (route === 'GET /api/me/export')
      return json(res, 200, { account, exportedAt: new Date().toISOString() });
    if (route === 'DELETE /api/me') {
      users.delete(account.email);
      for (const [t, id] of sessions) if (id === account.id) sessions.delete(t);
      room.remove(account.id);
      return json(res, 200, {}, { 'set-cookie': 'sid=; Path=/; Max-Age=0' });
    }
    if (route === 'POST /api/ws-ticket') {
      const ticket = crypto.randomUUID();
      tickets.set(ticket, account.id);
      setTimeout(() => tickets.delete(ticket), 30_000).unref();
      return json(res, 200, { ticket });
    }
    return err(res, 404, 'NOT_FOUND', 'Not found.');
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://mock');
    const ticket = url.searchParams.get('ticket') ?? '';
    const accountId = tickets.get(ticket);
    tickets.delete(ticket); // single use
    const account = accountId ? byId(accountId) : undefined;
    if (url.pathname !== '/ws' || !account) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      return void socket.destroy();
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const leave = room.join(
        account,
        (m) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(m)),
      );
      if (!leave) return void ws.close(1008, 'room full');
      ws.on('close', leave);
    });
  });
  server.on('close', () => room.close());
  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.MOCK_PORT ?? 8787);
  createMock().listen(port, () =>
    console.log(`mock server on http://localhost:${port}`),
  );
}
