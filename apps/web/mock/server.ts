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
  ChangePasswordInputSchema,
  DeleteAccountInputSchema,
  LoginInputSchema,
  SignupInputSchema,
  type Account,
  type ExportJob,
} from '@game/schema';
import { Room } from './room.js';

// The contract has no HTTP error schema yet; reuse the WS Error payload shape {code, message}.
const MIN_AGE = 18;

function deviceLabel(ua: string): string {
  const browser = /Firefox/.test(ua)
    ? 'Firefox'
    : /Edg/.test(ua)
      ? 'Edge'
      : /Chrome/.test(ua)
        ? 'Chrome'
        : /Safari/.test(ua)
          ? 'Safari'
          : 'Browser';
  const os = /Mac OS X/.test(ua)
    ? 'macOS'
    : /Windows/.test(ua)
      ? 'Windows'
      : /Android/.test(ua)
        ? 'Android'
        : /Linux/.test(ua)
          ? 'Linux'
          : 'unknown OS';
  return `${browser} on ${os}`;
}

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

export function createMock(
  opts: {
    scriptedFlipMs?: number;
    /** Export job turns ready after this long, then expires after exportExpireMs from request. */
    exportReadyMs?: number;
    exportExpireMs?: number;
  } = {},
) {
  const { exportReadyMs = 1500, exportExpireMs = 60_000 } = opts;
  const room = new Room(opts.scriptedFlipMs);
  const users = new Map<string, { account: Account; password: string }>(); // by email
  const sessions = new Map<string, string>(); // token -> accountId
  const meta = new Map<string, { id: string; label: string; at: number }>(); // token -> device info
  const exports = new Map<string, number>(); // accountId -> requestedAt ms
  const tickets = new Map<string, string>(); // ticket -> accountId (single use)
  // Every mock table shares the one Room actor below; only the invite/membership bookkeeping is per table.
  type MockRoom = {
    id: string;
    name: string;
    hostId: string;
    code: string;
    members: Set<string>;
  };
  const rooms = new Map<string, MockRoom>();
  const newCode = () => Math.random().toString(36).slice(2, 8).toUpperCase();
  const roomView = (r: MockRoom, accountId: string) => ({
    id: r.id,
    name: r.name,
    isHost: r.hostId === accountId,
    ...(r.hostId === accountId ? { code: r.code } : {}),
  });
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
  const tokenOf = (req: IncomingMessage) =>
    /(?:^|; )sid=([^;]+)/.exec(req.headers.cookie ?? '')?.[1];
  const authed = (req: IncomingMessage) => {
    const token = tokenOf(req);
    const id = token && sessions.get(token);
    if (token && id) meta.get(token)!.at = Date.now();
    return id ? byId(id) : undefined;
  };
  const login = (req: IncomingMessage, account: Account) => {
    const token = crypto.randomUUID();
    sessions.set(token, account.id);
    meta.set(token, {
      id: crypto.randomUUID(),
      label: deviceLabel(req.headers['user-agent'] ?? ''),
      at: Date.now(),
    });
    return { 'set-cookie': `sid=${token}; Path=/; HttpOnly; SameSite=Lax` };
  };

  const exportJob = (id: string): ExportJob | null => {
    const at = exports.get(id);
    if (at === undefined) return null;
    const age = Date.now() - at;
    const base = { requestedAt: new Date(at).toISOString() };
    if (age < exportReadyMs) return { ...base, status: 'pending' };
    if (age >= exportExpireMs) return { ...base, status: 'expired' };
    return {
      ...base,
      status: 'ready',
      downloadUrl: '/api/me/export',
      expiresAt: new Date(at + exportExpireMs).toISOString(),
    };
  };

  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://mock');
    const route = `${req.method} ${url.pathname}`;
    // Dev-only CORS reflect so a Vite dev server on another port can call the mock.
    if (req.headers.origin) {
      res.setHeader('access-control-allow-origin', req.headers.origin);
      res.setHeader('access-control-allow-credentials', 'true');
      res.setHeader('access-control-allow-headers', 'content-type');
      res.setHeader(
        'access-control-allow-methods',
        'GET,POST,PATCH,DELETE,OPTIONS',
      );
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
      return json(res, 201, { account }, login(req, account));
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
      return json(res, 200, { account: u.account }, login(req, u.account));
    }
    if (route === 'POST /api/logout') {
      const token = tokenOf(req);
      if (token) {
        sessions.delete(token);
        meta.delete(token);
      }
      return json(res, 200, {}, { 'set-cookie': 'sid=; Path=/; Max-Age=0' });
    }

    if (route === 'POST /api/verify-email') {
      const body = await readBody(req);
      if (body?.token !== 'valid-token')
        return err(
          res,
          400,
          'TOKEN_INVALID',
          'This link is invalid or has expired.',
        );
      return json(res, 200, {});
    }
    if (route === 'POST /api/password/forgot') {
      await readBody(req);
      return json(res, 202, {}); // same answer whether or not the email exists
    }
    if (route === 'POST /api/password/reset') {
      const body = await readBody(req);
      if (typeof body?.password !== 'string' || body.password.length < 12)
        return err(
          res,
          400,
          'INVALID_INPUT',
          'Password must be at least 12 characters.',
        );
      if (body.token !== 'valid-token')
        return err(
          res,
          400,
          'TOKEN_INVALID',
          'This link is invalid or has expired.',
        );
      return json(res, 200, {});
    }

    const account = authed(req);
    if (url.pathname.startsWith('/api/') && !account)
      return err(res, 401, 'UNAUTHENTICATED', 'Sign in required.');
    if (!account) return err(res, 404, 'NOT_FOUND', 'Not found.');

    if (route === 'GET /api/me') return json(res, 200, { account });
    if (route === 'PATCH /api/me') {
      const name = (await readBody(req))?.displayName;
      if (typeof name !== 'string' || !name.trim() || name.trim().length > 80)
        return err(res, 400, 'INVALID_INPUT', 'Enter a display name.');
      account.displayName = name.trim();
      return json(res, 200, { account });
    }
    if (route === 'POST /api/me/password') {
      const parsed = ChangePasswordInputSchema.safeParse(await readBody(req));
      if (!parsed.success)
        return err(
          res,
          400,
          'INVALID_INPUT',
          'New password must be at least 12 characters.',
        );
      const u = users.get(account.email)!;
      if (u.password !== parsed.data.currentPassword)
        return err(
          res,
          403,
          'BAD_CREDENTIALS',
          'Current password is incorrect.',
        );
      u.password = parsed.data.newPassword;
      return json(res, 200, {});
    }
    const mine = () =>
      [...sessions].filter(([, id]) => id === account.id).map(([t]) => t);
    if (route === 'GET /api/me/sessions')
      return json(res, 200, {
        sessions: mine()
          .map((t) => ({ t, m: meta.get(t)! }))
          .sort((a, b) => b.m.at - a.m.at)
          .map(({ t, m }) => ({
            id: m.id,
            label: m.label,
            lastActiveAt: new Date(m.at).toISOString(),
            current: t === tokenOf(req),
          })),
      });
    if (route === 'POST /api/me/sessions/revoke-others') {
      for (const t of mine())
        if (t !== tokenOf(req)) {
          sessions.delete(t);
          meta.delete(t);
        }
      return json(res, 200, {});
    }
    const sess = /^\/api\/me\/sessions\/([^/]+)$/.exec(url.pathname);
    if (req.method === 'DELETE' && sess) {
      const t = mine().find((x) => meta.get(x)!.id === sess[1]);
      if (!t) return err(res, 404, 'NOT_FOUND', 'Not found.');
      sessions.delete(t);
      meta.delete(t);
      return json(res, 200, {});
    }
    if (route === 'POST /api/me/export') {
      exports.set(account.id, Date.now());
      return json(res, 202, { job: exportJob(account.id) });
    }
    if (route === 'GET /api/me/export-job')
      return json(res, 200, { job: exportJob(account.id) });
    if (route === 'GET /api/me/export') {
      if (exportJob(account.id)?.status !== 'ready')
        return err(res, 404, 'NOT_FOUND', 'No export is ready.');
      return json(res, 200, { account, exportedAt: new Date().toISOString() });
    }
    if (route === 'DELETE /api/me') {
      const parsed = DeleteAccountInputSchema.safeParse(await readBody(req));
      if (!parsed.success)
        return err(
          res,
          400,
          'INVALID_INPUT',
          'Type the confirmation phrase exactly.',
        );
      if (users.get(account.email)!.password !== parsed.data.password)
        return err(res, 403, 'BAD_CREDENTIALS', 'Password is incorrect.');
      users.delete(account.email);
      for (const t of mine()) {
        sessions.delete(t);
        meta.delete(t);
      }
      room.remove(account.id);
      return json(res, 200, {}, { 'set-cookie': 'sid=; Path=/; Max-Age=0' });
    }
    if (route === 'GET /api/rooms')
      return json(res, 200, {
        rooms: [...rooms.values()]
          .filter((r) => r.members.has(account.id))
          .map((r) => roomView(r, account.id)),
      });
    if (route === 'POST /api/rooms') {
      const body = await readBody(req);
      const name = typeof body?.name === 'string' ? body.name.trim() : '';
      if (!name || name.length > 80)
        return err(res, 400, 'INVALID_INPUT', 'Enter a table name.');
      const r: MockRoom = {
        id: crypto.randomUUID(),
        name,
        hostId: account.id,
        code: newCode(),
        members: new Set([account.id]),
      };
      rooms.set(r.id, r);
      return json(res, 201, { room: roomView(r, account.id) });
    }
    const roomRoute = /^\/api\/rooms\/([^/]+)(\/invite)?$/.exec(url.pathname);
    if (roomRoute) {
      const r = rooms.get(roomRoute[1]!);
      if (!r?.members.has(account.id))
        return err(res, 404, 'NOT_FOUND', 'Not found.');
      if (req.method === 'GET' && !roomRoute[2])
        return json(res, 200, { room: roomView(r, account.id) });
      if (req.method === 'POST' && roomRoute[2]) {
        if (r.hostId !== account.id)
          return err(res, 403, 'FORBIDDEN', 'Only the host can do that.');
        r.code = newCode(); // old link stops working immediately
        return json(res, 200, { room: roomView(r, account.id) });
      }
    }
    const joinRoute = /^\/api\/invites\/([^/]+)\/join$/.exec(url.pathname);
    if (req.method === 'POST' && joinRoute) {
      const r = [...rooms.values()].find(
        (x) => x.code === joinRoute[1]!.toUpperCase(),
      );
      if (!r)
        return err(
          res,
          404,
          'INVITE_INVALID',
          'This invite link is no longer valid.',
        );
      if (!r.members.has(account.id) && r.members.size >= 6)
        return err(res, 409, 'ROOM_FULL', 'This table is full.');
      r.members.add(account.id);
      return json(res, 200, { room: roomView(r, account.id) });
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
