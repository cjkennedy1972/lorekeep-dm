import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import {
  EgressError,
  createEgressGuard,
  type EgressOptions,
  type Resolver,
  type Transport,
  type TransportRequest,
} from '../../src/llm/egress.js';
import { Secret } from '../../src/llm/secret.js';

const PUBLIC = '93.184.216.34';
const ok = (): ReturnType<Transport> =>
  Promise.resolve({
    status: 200,
    headers: {},
    body: new Response('{"ok":true}').body,
  });
function harness(opts: EgressOptions = {}, dns: Record<string, string[]> = {}) {
  const calls: TransportRequest[] = [];
  const lookups: string[] = [];
  const resolver: Resolver = async (h) => {
    lookups.push(h);
    const a = dns[h];
    if (!a) throw new Error('NXDOMAIN');
    return a.map((address) => ({
      address,
      family: address.includes(':') ? 6 : 4,
    }));
  };
  const transport: Transport = (req) => {
    calls.push(req);
    return ok();
  };
  const guard = createEgressGuard({ resolver, transport, ...opts });
  return { guard, calls, lookups };
}
const rejects = async (p: Promise<unknown>, code: string) => {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(EgressError);
  expect((err as EgressError).code).toBe(code);
};

describe('egress guard: default policy (no local allowlist)', () => {
  it('accepts a public https host and connects to the validated address', async () => {
    const h = harness({}, { 'api.example.com': [PUBLIC] });
    const res = await h.guard.fetch('https://api.example.com/v1/chat', {
      method: 'POST',
      body: '{}',
    });
    expect(res.status).toBe(200);
    expect(h.calls[0]?.address.address).toBe(PUBLIC);
  });

  it.each([
    ['http://api.example.com/', 'egress-scheme'],
    ['ftp://api.example.com/', 'egress-scheme'],
    ['file:///etc/passwd', 'egress-scheme'],
    ['https://user:pw@api.example.com/', 'egress-userinfo'],
    ['https://:pw@api.example.com/', 'egress-userinfo'],
    ['https://api.example.com:8443/', 'egress-port'],
    ['https://api.example.com:22/', 'egress-port'],
    ['not a url', 'egress-url-invalid'],
    ['https://metadata.google.internal/', 'egress-blocked-address'],
  ])('rejects %s', async (url, code) => {
    const h = harness({}, { 'api.example.com': [PUBLIC] });
    await rejects(h.guard.fetch(url), code);
    expect(h.calls).toHaveLength(0);
  });

  const blockedLiterals = [
    // loopback / private / CGNAT
    'https://127.0.0.1/',
    'https://127.1.2.3/',
    'https://10.0.0.5/',
    'https://172.16.0.1/',
    'https://172.31.255.255/',
    'https://192.168.1.1/',
    'https://100.64.0.1/',
    'https://[::1]/',
    'https://[fc00::1]/',
    'https://[fd12:3456::1]/',
    // metadata + link-local + unspecified
    'https://169.254.169.254/latest/meta-data/',
    'https://169.254.0.1/',
    'https://100.100.100.200/',
    'https://168.63.129.16/',
    'https://[fd00:ec2::254]/',
    'https://[fe80::1]/',
    'https://0.0.0.0/',
    'https://[::]/',
    // IPv4-mapped / compatible / NAT64 / 6to4 wrappers
    'https://[::ffff:127.0.0.1]/',
    'https://[::ffff:7f00:1]/',
    'https://[::ffff:169.254.169.254]/',
    'https://[::ffff:a9fe:a9fe]/',
    'https://[::127.0.0.1]/',
    'https://[64:ff9b::7f00:1]/',
    'https://[64:ff9b::a9fe:a9fe]/',
    'https://[2002:7f00:1::]/',
    'https://[2002:a9fe:a9fe::1]/',
    // numeric encodings the URL parser normalizes
    'https://2130706433/', // decimal 127.0.0.1
    'https://0x7f000001/', // hex
    'https://0x7f.0.0.1/',
    'https://0177.0.0.1/', // octal
    'https://017700000001/', // octal full
    'https://127.1/', // short form
    'https://2852039166/', // decimal 169.254.169.254
    'https://0xa9fea9fe/',
    'https://0251.0376.0251.0376/',
    'https://127.0.0.1./', // trailing dot
  ];
  it.each(blockedLiterals)('rejects %s', async (url) => {
    const h = harness();
    const err = await h.guard.fetch(url).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(EgressError);
    expect(['egress-private-address', 'egress-blocked-address']).toContain(
      (err as EgressError).code,
    );
    expect(h.calls).toHaveLength(0);
  });

  it('rejects hostnames that resolve to private or metadata addresses', async () => {
    const h = harness(
      {},
      {
        'a.example.com': ['10.1.1.1'],
        'b.example.com': ['127.0.0.1'],
        'c.example.com': ['169.254.169.254'],
        'd.example.com': ['::ffff:7f00:1'],
        localhost: ['127.0.0.1', '::1'],
      },
    );
    await rejects(
      h.guard.fetch('https://a.example.com/'),
      'egress-private-address',
    );
    await rejects(
      h.guard.fetch('https://b.example.com/'),
      'egress-private-address',
    );
    await rejects(
      h.guard.fetch('https://c.example.com/'),
      'egress-blocked-address',
    );
    await rejects(
      h.guard.fetch('https://d.example.com/'),
      'egress-private-address',
    );
    await rejects(
      h.guard.fetch('https://localhost/'),
      'egress-private-address',
    );
  });

  it('refuses mixed answer sets (one public, one private)', async () => {
    const h = harness({}, { 'mix.example.com': [PUBLIC, '10.0.0.9'] });
    await rejects(
      h.guard.fetch('https://mix.example.com/'),
      'egress-private-address',
    );
  });

  it('fails closed on DNS failure and empty answers', async () => {
    const h = harness({}, { 'empty.example.com': [] });
    await rejects(h.guard.fetch('https://nx.example.com/'), 'egress-dns');
    await rejects(h.guard.fetch('https://empty.example.com/'), 'egress-dns');
  });

  it('defeats DNS rebinding: one resolution per request, connect uses it', async () => {
    const answers = [[PUBLIC], ['169.254.169.254']];
    let n = 0;
    const lookups: string[] = [];
    const calls: TransportRequest[] = [];
    const guard = createEgressGuard({
      resolver: async (h) => {
        lookups.push(h);
        return (answers[Math.min(n++, 1)] ?? []).map((address) => ({
          address,
          family: 4 as const,
        }));
      },
      transport: (req) => (calls.push(req), ok()),
    });
    await guard.fetch('https://rebind.example.com/');
    expect(calls[0]?.address.address).toBe(PUBLIC);
    expect(lookups).toHaveLength(1); // transport is handed the address; no 2nd lookup
    // second request sees the hostile answer and is refused before connecting
    await rejects(
      guard.fetch('https://rebind.example.com/'),
      'egress-blocked-address',
    );
    expect(calls).toHaveLength(1);
  });

  it('refuses redirects (including to the metadata IP) and never follows', async () => {
    const calls: TransportRequest[] = [];
    const guard = createEgressGuard({
      resolver: async () => [{ address: PUBLIC, family: 4 }],
      transport: async (req) => {
        calls.push(req);
        return {
          status: 302,
          headers: { location: 'http://169.254.169.254/latest/meta-data/' },
          body: null,
        };
      },
    });
    await rejects(guard.fetch('https://api.example.com/'), 'egress-redirect');
    expect(calls).toHaveLength(1);
  });

  it('enforces the response size limit mid-stream', async () => {
    const guard = createEgressGuard({
      maxResponseBytes: 10,
      resolver: async () => [{ address: PUBLIC, family: 4 }],
      transport: async () => ({
        status: 200,
        headers: {},
        body: new Response('x'.repeat(100)).body,
      }),
    });
    const res = await guard.fetch('https://api.example.com/');
    await expect(res.text()).rejects.toMatchObject({
      code: 'egress-too-large',
    });
  });

  it('enforces the time limit', async () => {
    const guard = createEgressGuard({
      timeoutMs: 20,
      resolver: async () => [{ address: PUBLIC, family: 4 }],
      transport: (req) =>
        new Promise((_, reject) =>
          req.signal.addEventListener('abort', () =>
            reject(new Error('aborted')),
          ),
        ),
    });
    await rejects(guard.fetch('https://api.example.com/'), 'egress-timeout');
  });
});

describe('egress guard: operator local allowlist', () => {
  it('allows an allowlisted loopback endpoint over http on any port', async () => {
    const h = harness(
      { allowLocalHosts: ['127.0.0.1', 'localhost'] },
      { localhost: ['127.0.0.1', '::1'] },
    );
    await h.guard.fetch('http://127.0.0.1:11434/v1/chat/completions');
    await h.guard.fetch('http://localhost:1234/v1/chat/completions');
    expect(h.calls).toHaveLength(2);
  });

  it('only allowlists the exact host named, not other local hosts', async () => {
    const h = harness({ allowLocalHosts: ['127.0.0.1'] });
    await rejects(h.guard.fetch('http://127.0.0.2:11434/'), 'egress-scheme');
    await rejects(h.guard.fetch('https://10.0.0.5/'), 'egress-private-address');
    await rejects(h.guard.fetch('https://[::1]/'), 'egress-private-address');
  });

  it('never allows metadata/link-local, even when allowlisted', async () => {
    const h = harness(
      {
        allowLocalHosts: [
          '169.254.169.254',
          'metadata.google.internal',
          'evil.example.com',
          '0.0.0.0',
        ],
      },
      { 'evil.example.com': ['169.254.169.254'] },
    );
    await rejects(
      h.guard.fetch('http://169.254.169.254/'),
      'egress-blocked-address',
    );
    await rejects(
      h.guard.fetch('http://metadata.google.internal/'),
      'egress-blocked-address',
    );
    await rejects(
      h.guard.fetch('http://evil.example.com/'),
      'egress-blocked-address',
    );
    await rejects(h.guard.fetch('http://0.0.0.0/'), 'egress-blocked-address');
    await rejects(
      h.guard.fetch('https://[::ffff:a9fe:a9fe]/'),
      'egress-blocked-address',
    );
  });

  it('still refuses redirects from an allowlisted endpoint', async () => {
    const guard = createEgressGuard({
      allowLocalHosts: ['127.0.0.1'],
      transport: async () => ({
        status: 307,
        headers: { location: 'http://169.254.169.254/' },
        body: null,
      }),
    });
    await rejects(guard.fetch('http://127.0.0.1:8080/'), 'egress-redirect');
  });
});

describe('egress guard: real transport (loopback only, no external network)', () => {
  it('pins to the validated address, ignoring the hostname DNS', async () => {
    const { createServer } = await import('node:http');
    const server = createServer((_, res) => res.end('pinned'));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    try {
      // "model.invalid" cannot resolve via real DNS; only the pinned address works.
      const guard = createEgressGuard({
        allowLocalHosts: ['model.invalid'],
        resolver: async () => [{ address: '127.0.0.1', family: 4 }],
      });
      const res = await guard.fetch(`http://model.invalid:${port}/`);
      expect(await res.text()).toBe('pinned');
    } finally {
      server.close();
    }
  });
});

describe('structure: the guard is the only outbound client in llm/', () => {
  it('has no direct fetch/http usage outside egress.ts', () => {
    const root = join(__dirname, '../../src/llm');
    const walk = (d: string): string[] =>
      readdirSync(d, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)],
      );
    for (const f of walk(root).filter(
      (p) => p.endsWith('.ts') && !p.endsWith('egress.ts'),
    )) {
      const src = readFileSync(f, 'utf8');
      expect(src, f).not.toMatch(
        /(?<![.\w])fetch\(|node:https?|from 'undici'|node:net/,
      );
    }
  });
});

describe('secret handling', () => {
  const KEY = 'sk-super-secret-123';
  it('Secret never serializes, stringifies or inspects to the key', () => {
    const s = new Secret(KEY);
    for (const out of [
      String(s),
      `${s}`,
      JSON.stringify({ s }),
      inspect(s),
      inspect({ nested: { s } }, { depth: 5 }),
    ])
      expect(out).not.toContain(KEY);
    expect(s.reveal()).toBe(KEY);
  });

  it('config wraps LLM_API_KEY and parses the local allowlist', () => {
    const cfg = loadConfig({
      DATABASE_URL: 'postgres://u:p@localhost/db',
      LLM_API_KEY: KEY,
      LLM_ALLOW_LOCAL_HOSTS: ' localhost , 127.0.0.1 ,',
    });
    expect(JSON.stringify(cfg)).not.toContain(KEY);
    expect(inspect(cfg)).not.toContain(KEY);
    expect(cfg.LLM_ALLOW_LOCAL_HOSTS).toEqual(['localhost', '127.0.0.1']);
    expect(
      loadConfig({ DATABASE_URL: 'postgres://u:p@localhost/db' })
        .LLM_ALLOW_LOCAL_HOSTS,
    ).toEqual([]);
  });

  it('egress errors never contain the URL, userinfo or key', async () => {
    const h = harness();
    const err = await h.guard
      .fetch(`https://user:${KEY}@10.0.0.1/?key=${KEY}`, {
        headers: { authorization: `Bearer ${KEY}` },
      })
      .catch((e: unknown) => e);
    expect(
      JSON.stringify(err) +
        String((err as Error).message) +
        (err as Error).stack,
    ).not.toContain(KEY);
  });
});
