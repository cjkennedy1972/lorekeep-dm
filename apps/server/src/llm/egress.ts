import { lookup as dnsLookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import { Readable } from 'node:stream';

/** Outbound endpoint guard (M2-19): the only HTTP client LLM adapters may use. */
export type EgressErrorCode =
  | 'egress-url-invalid'
  | 'egress-scheme'
  | 'egress-userinfo'
  | 'egress-port'
  | 'egress-blocked-address'
  | 'egress-private-address'
  | 'egress-dns'
  | 'egress-redirect'
  | 'egress-too-large'
  | 'egress-timeout';

/** Messages are fixed strings: never URLs, headers or bodies (may hold keys). */
export class EgressError extends Error {
  constructor(
    readonly code: EgressErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'EgressError';
  }
}

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}
export type Resolver = (hostname: string) => Promise<ResolvedAddress[]>;
export interface TransportRequest {
  url: URL;
  /** The validated address to connect to; the transport must not re-resolve. */
  address: ResolvedAddress;
  method: string;
  headers: Record<string, string>;
  body?: string;
  signal: AbortSignal;
}
export interface TransportResponse {
  status: number;
  headers: Record<string, string>;
  body: ReadableStream<Uint8Array> | null;
}
export type Transport = (req: TransportRequest) => Promise<TransportResponse>;

export interface EgressOptions {
  /**
   * Operator allowlist of exact hostnames / IP literals, optionally with a port
   * (e.g. "localhost", "172.31.25.75:8080", "[::1]:8080"). A bare host permits
   * ports 80 and 443 only; a host:port permits that port only. Listed hosts may
   * resolve to loopback/private ranges and use plain http. Metadata/link-local
   * never allowed.
   */
  allowLocalHosts?: readonly string[];
  /** @deprecated Port-only list; applies only to hosts already in allowLocalHosts. Use host:port entries. */
  allowedPorts?: readonly number[];
  maxResponseBytes?: number;
  timeoutMs?: number;
  resolver?: Resolver;
  transport?: Transport;
}
export interface EgressGuard {
  fetch(url: string, init?: RequestInit): Promise<Response>;
  validate(url: string): Promise<void>;
}

type AddrClass = 'public' | 'local' | 'blocked';

function parseV4(s: string): number[] | undefined {
  const p = s.split('.');
  if (p.length !== 4) return undefined;
  const n = p.map((x) => (/^\d{1,3}$/.test(x) ? Number(x) : NaN));
  return n.every((x) => x <= 255) ? n : undefined;
}

function parseV6(input: string): number[] | undefined {
  let s = input.split('%')[0] ?? '';
  const tail = s.lastIndexOf(':') >= 0 ? s.slice(s.lastIndexOf(':') + 1) : '';
  if (tail.includes('.')) {
    const v4 = parseV4(tail);
    if (!v4) return undefined;
    const h = (a: number, b: number) => ((a << 8) | b).toString(16);
    s = `${s.slice(0, s.lastIndexOf(':') + 1)}${h(v4[0]!, v4[1]!)}:${h(v4[2]!, v4[3]!)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return undefined;
  const groups = (x: string) => (x === '' ? [] : x.split(':'));
  const head = groups(halves[0]!);
  const rest = halves.length === 2 ? groups(halves[1]!) : [];
  const fill = halves.length === 2 ? 8 - head.length - rest.length : 0;
  if (fill < (halves.length === 2 ? 1 : 0)) return undefined;
  const all = [...head, ...Array<string>(fill).fill('0'), ...rest];
  if (all.length !== 8 || !all.every((g) => /^[0-9a-f]{1,4}$/i.test(g)))
    return undefined;
  return all.flatMap((g) => {
    const v = parseInt(g, 16);
    return [v >> 8, v & 255];
  });
}

function classifyV4(b: number[]): AddrClass {
  const [a, c] = [b[0]!, b[1]!];
  const ip = b.join('.');
  if (ip === '168.63.129.16' || ip === '100.100.100.200') return 'blocked';
  if (a === 0 || a >= 224) return 'blocked'; // this-net, multicast, reserved, broadcast
  if (a === 169 && c === 254) return 'blocked'; // link-local incl. 169.254.169.254
  if (ip === '192.0.0.192') return 'blocked';
  if (a === 127 || a === 10) return 'local';
  if (a === 172 && c >= 16 && c <= 31) return 'local';
  if (a === 192 && c === 168) return 'local';
  if (a === 100 && c >= 64 && c <= 127) return 'local'; // CGNAT
  if (a === 198 && (c === 18 || c === 19)) return 'local';
  if (a === 192 && c === 0 && b[2] === 0) return 'local';
  if (
    (a === 192 && c === 0 && b[2] === 2) ||
    (a === 198 && c === 51 && b[2] === 100) ||
    (a === 203 && c === 0 && b[2] === 113)
  )
    return 'local'; // documentation ranges
  return 'public';
}

/** Classify an IP literal. Embedded-IPv4 IPv6 forms inherit the v4 verdict. */
export function classifyAddress(ip: string): AddrClass {
  const v4 = parseV4(ip);
  if (v4) return classifyV4(v4);
  const b = parseV6(ip);
  if (!b) return 'blocked'; // unparseable: fail closed
  const zeros = (n: number) => b.slice(0, n).every((x) => x === 0);
  if (b.every((x) => x === 0)) return 'blocked'; // ::
  if (zeros(15) && b[15] === 1) return 'local'; // ::1
  const embedded = b.slice(12);
  if (zeros(10) && b[10] === 0xff && b[11] === 0xff)
    return classifyV4(embedded);
  if (zeros(12)) return classifyV4(embedded); // IPv4-compatible ::a.b.c.d
  if (
    b[0] === 0 &&
    b[1] === 0x64 &&
    b[2] === 0xff &&
    b[3] === 0x9b &&
    b.slice(4, 12).every((x) => x === 0)
  )
    return classifyV4(embedded); // NAT64 64:ff9b::/96
  if (b[0] === 0x20 && b[1] === 0x02) return classifyV4(b.slice(2, 6)); // 6to4
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0 && b[3] === 0)
    return 'blocked'; // Teredo
  if (b[0] === 0xfd && b[1] === 0x00 && b[2] === 0x0e && b[3] === 0xc2)
    return 'blocked'; // AWS IMDS v6
  if (b[0] === 0xfe && (b[1]! & 0xc0) === 0x80) return 'blocked'; // fe80::/10
  if (b[0]! >= 0xff) return 'blocked'; // multicast
  if ((b[0]! & 0xfe) === 0xfc) return 'local'; // fc00::/7 ULA
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x0d && b[3] === 0xb8)
    return 'local';
  if (b[0] === 0x01 && b.slice(1, 8).every((x) => x === 0)) return 'blocked'; // discard
  return 'public';
}

const BLOCKED_NAMES = new Set([
  'metadata.google.internal',
  'metadata',
  'instance-data',
]);

const defaultResolver: Resolver = async (hostname) =>
  (await dnsLookup(hostname, { all: true, verbatim: true })).map((a) => ({
    address: a.address,
    family: a.family === 6 ? 6 : 4,
  }));

/** Connects to the pre-validated address (no second DNS lookup => no rebinding). */
const nodeTransport: Transport = (req) =>
  new Promise((resolve, reject) => {
    const lib = req.url.protocol === 'https:' ? https : http;
    const host = req.url.hostname.replace(/^\[|\]$/g, '');
    const r = lib.request(
      {
        host,
        port: req.url.port || undefined,
        path: `${req.url.pathname}${req.url.search}`,
        method: req.method,
        headers: req.headers,
        signal: req.signal,
        servername: isIP(host) ? undefined : host,
        lookup: (_h, _o, cb: (...a: unknown[]) => void) => {
          const opts = _o as { all?: boolean };
          if (opts?.all) cb(null, [req.address]);
          else cb(null, req.address.address, req.address.family);
        },
      } as https.RequestOptions,
      (res) => {
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(res.headers))
          if (v !== undefined) headers[k] = Array.isArray(v) ? v.join(', ') : v;
        resolve({
          status: res.statusCode ?? 0,
          headers,
          body: Readable.toWeb(res) as ReadableStream<Uint8Array>,
        });
      },
    );
    r.on('error', reject);
    r.end(req.body);
  });

const DEFAULT_LOCAL_PORTS = [80, 443];
let warnedLegacyPorts = false;

function parseAllowEntry(entry: string): { host: string; port?: number } {
  const e = entry.trim().toLowerCase();
  const m = /^\[(.+)\](?::(\d+))?$/.exec(e) ?? /^([^:]+):(\d+)$/.exec(e);
  return m
    ? { host: m[1]!, port: m[2] ? Number(m[2]) : undefined }
    : { host: e };
}

export function createEgressGuard(options: EgressOptions = {}): EgressGuard {
  const legacyPorts = options.allowedPorts ?? [];
  if (legacyPorts.length && !warnedLegacyPorts) {
    warnedLegacyPorts = true;
    console.warn(
      'egress: allowedPorts is deprecated; use host:port entries in allowLocalHosts',
    );
  }
  const localPorts = new Map<string, Set<number>>();
  for (const entry of options.allowLocalHosts ?? []) {
    const { host, port } = parseAllowEntry(entry);
    const ports = localPorts.get(host) ?? new Set<number>();
    for (const p of port === undefined ? DEFAULT_LOCAL_PORTS : [port])
      ports.add(p);
    localPorts.set(host, ports);
  }
  for (const ports of localPorts.values())
    for (const p of legacyPorts) ports.add(p);
  const maxBytes = options.maxResponseBytes ?? 8 * 1024 * 1024;
  const timeoutMs = options.timeoutMs ?? 60_000;
  const resolver = options.resolver ?? defaultResolver;
  const transport = options.transport ?? nodeTransport;

  async function validate(
    raw: string,
  ): Promise<{ url: URL; address: ResolvedAddress }> {
    let url: URL;
    try {
      url = new URL(raw); // normalizes decimal/octal/hex/short IPv4 to dotted
    } catch {
      throw new EgressError('egress-url-invalid', 'Endpoint URL is invalid');
    }
    if (url.username || url.password)
      throw new EgressError(
        'egress-userinfo',
        'Endpoint URL must not contain credentials',
      );
    if (url.protocol !== 'https:' && url.protocol !== 'http:')
      throw new EgressError('egress-scheme', 'Endpoint scheme not allowed');
    const host = url.hostname
      .toLowerCase()
      .replace(/^\[|\]$/g, '')
      .replace(/\.$/, '');
    if (!host || BLOCKED_NAMES.has(host))
      throw new EgressError(
        'egress-blocked-address',
        'Endpoint address is blocked',
      );
    const ports = localPorts.get(host);
    const local = ports !== undefined;
    if (url.protocol === 'http:' && !local)
      throw new EgressError('egress-scheme', 'Endpoint must use https');
    const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
    if (!(ports ? ports.has(port) : port === 443))
      throw new EgressError('egress-port', 'Endpoint port not allowed');

    let addrs: ResolvedAddress[];
    if (isIP(host))
      addrs = [{ address: host, family: isIP(host) === 6 ? 6 : 4 }];
    else {
      try {
        addrs = await resolver(host);
      } catch {
        throw new EgressError(
          'egress-dns',
          'Endpoint host could not be resolved',
        );
      }
      if (!addrs.length)
        throw new EgressError(
          'egress-dns',
          'Endpoint host could not be resolved',
        );
    }
    // Every answer must pass; a mixed public/private answer set is refused.
    for (const a of addrs) {
      const c = classifyAddress(a.address);
      if (c === 'blocked')
        throw new EgressError(
          'egress-blocked-address',
          'Endpoint address is blocked',
        );
      if (c === 'local' && !local)
        throw new EgressError(
          'egress-private-address',
          'Endpoint resolves to a private address',
        );
    }
    return { url, address: addrs[0]! };
  }

  return {
    async validate(raw) {
      await validate(raw);
    },
    async fetch(raw, init = {}) {
      const { url, address } = await validate(raw);
      const ctl = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        ctl.abort();
      }, timeoutMs);
      const onAbort = () => ctl.abort();
      init.signal?.addEventListener('abort', onAbort, { once: true });
      const cleanup = () => {
        clearTimeout(timer);
        init.signal?.removeEventListener('abort', onAbort);
      };
      try {
        const headers: Record<string, string> = {};
        new Headers(init.headers).forEach((v, k) => (headers[k] = v));
        const res = await transport({
          url,
          address,
          method: init.method ?? 'GET',
          headers,
          body: typeof init.body === 'string' ? init.body : undefined,
          signal: ctl.signal,
        });
        if (res.status >= 300 && res.status < 400) {
          await res.body?.cancel().catch(() => undefined);
          cleanup();
          throw new EgressError(
            'egress-redirect',
            'Endpoint redirects are not followed',
          );
        }
        let seen = 0;
        const source = res.body?.getReader();
        const body = source
          ? new ReadableStream<Uint8Array>({
              async pull(c) {
                try {
                  const { done, value } = await source.read();
                  if (done) {
                    cleanup();
                    c.close();
                    return;
                  }
                  seen += value.byteLength;
                  if (seen > maxBytes) {
                    await source.cancel().catch(() => undefined);
                    ctl.abort();
                    cleanup();
                    c.error(
                      new EgressError(
                        'egress-too-large',
                        'Endpoint response too large',
                      ),
                    );
                    return;
                  }
                  c.enqueue(value);
                } catch {
                  cleanup();
                  c.error(
                    timedOut
                      ? new EgressError(
                          'egress-timeout',
                          'Endpoint request timed out',
                        )
                      : new EgressError(
                          'egress-timeout',
                          'Endpoint stream failed',
                        ),
                  );
                }
              },
              cancel: async () => {
                cleanup();
                ctl.abort();
                await source.cancel().catch(() => undefined);
              },
            })
          : null;
        return new Response(body, { status: res.status, headers: res.headers });
      } catch (error) {
        cleanup();
        if (error instanceof EgressError) throw error;
        if (timedOut)
          throw new EgressError('egress-timeout', 'Endpoint request timed out');
        if (init.signal?.aborted)
          throw Object.assign(new Error('aborted'), { name: 'AbortError' });
        throw new EgressError('egress-dns', 'Endpoint request failed');
      }
    },
  };
}
