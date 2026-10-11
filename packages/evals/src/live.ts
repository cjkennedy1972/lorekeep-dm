import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { isIP } from 'node:net';
import { runEval } from './run.js';
import type { EvalModel, EvalRecord } from './types.js';

// Pinned copy of apps/server/src/llm/egress.ts (BLOCKED_NAMES, parseAllowEntry, classifyAddress).
// apps/server/test/llm/live-url-differential.test.ts fails on any verdict drift over data/live-url-corpus.json.
const BLOCKED_NAMES = new Set([
  'metadata.google.internal',
  'metadata',
  'instance-data',
]);

function parseAllowEntry(entry: string): { host: string; port?: number } {
  const e = entry.trim().toLowerCase();
  const m = /^\[(.+)\](?::(\d+))?$/.exec(e) ?? /^([^:]+):(\d+)$/.exec(e);
  return m
    ? { host: m[1]!, port: m[2] ? Number(m[2]) : undefined }
    : { host: e };
}

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

type AddrClass = 'public' | 'local' | 'blocked';

function classifyV4(b: number[]): AddrClass {
  const [a, c] = [b[0]!, b[1]!];
  const ip = b.join('.');
  if (ip === '168.63.129.16' || ip === '100.100.100.200') return 'blocked';
  if (a === 0 || a >= 224) return 'blocked';
  if (a === 169 && c === 254) return 'blocked';
  if (ip === '192.0.0.192') return 'blocked';
  if (a === 127 || a === 10) return 'local';
  if (a === 172 && c >= 16 && c <= 31) return 'local';
  if (a === 192 && c === 168) return 'local';
  if (a === 100 && c >= 64 && c <= 127) return 'local';
  if (a === 198 && (c === 18 || c === 19)) return 'local';
  if (a === 192 && c === 0 && b[2] === 0) return 'local';
  if (
    (a === 192 && c === 0 && b[2] === 2) ||
    (a === 198 && c === 51 && b[2] === 100) ||
    (a === 203 && c === 0 && b[2] === 113)
  )
    return 'local';
  return 'public';
}

function classifyAddress(ip: string): AddrClass {
  const v4 = parseV4(ip);
  if (v4) return classifyV4(v4);
  const b = parseV6(ip);
  if (!b) return 'blocked';
  const zeros = (n: number) => b.slice(0, n).every((x) => x === 0);
  if (b.every((x) => x === 0)) return 'blocked';
  if (zeros(15) && b[15] === 1) return 'local';
  const embedded = b.slice(12);
  if (zeros(10) && b[10] === 0xff && b[11] === 0xff)
    return classifyV4(embedded);
  if (zeros(12)) return classifyV4(embedded);
  if (
    b[0] === 0 &&
    b[1] === 0x64 &&
    b[2] === 0xff &&
    b[3] === 0x9b &&
    b.slice(4, 12).every((x) => x === 0)
  )
    return classifyV4(embedded);
  if (b[0] === 0x20 && b[1] === 0x02) return classifyV4(b.slice(2, 6));
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0 && b[3] === 0)
    return 'blocked';
  if (b[0] === 0xfd && b[1] === 0x00 && b[2] === 0x0e && b[3] === 0xc2)
    return 'blocked';
  if (b[0] === 0xfe && (b[1]! & 0xc0) === 0x80) return 'blocked';
  if (b[0]! >= 0xff) return 'blocked';
  if ((b[0]! & 0xfe) === 0xfc) return 'local';
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x0d && b[3] === 0xb8)
    return 'local';
  if (b[0] === 0x01 && b.slice(1, 8).every((x) => x === 0)) return 'blocked';
  return 'public';
}

/** Same verdicts as the egress guard for the host/port/scheme/address axis, without DNS. */
export function checkLiveUrl(
  baseUrl: string,
  allowLocal = process.env.LLM_ALLOW_LOCAL_HOSTS ?? '',
): URL {
  const url = new URL(baseUrl);
  const host = url.hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
  const listed = allowLocal
    .split(',')
    .map(parseAllowEntry)
    .filter((e) => e.host === host);
  const isListed = listed.length > 0;
  const portAllowed = isListed
    ? listed.some((e) =>
        e.port === undefined ? port === 80 || port === 443 : e.port === port,
      )
    : port === 443;
  const addressAllowed = !isIP(host)
    ? !BLOCKED_NAMES.has(host)
    : (() => {
        const c = classifyAddress(host);
        return c === 'public' || (c === 'local' && isListed);
      })();
  const schemeAllowed = url.protocol === 'https:' || isListed;
  if (
    url.username ||
    url.password ||
    !host ||
    !portAllowed ||
    !addressAllowed ||
    !schemeAllowed ||
    !['https:', 'http:'].includes(url.protocol)
  )
    throw new Error(
      `live endpoint ${url.hostname} must be https on port 443 or listed in LLM_ALLOW_LOCAL_HOSTS`,
    );
  return url;
}

/** OpenAI-compatible chat completions, temperature 0 and the per-case seed. Key from EVAL_API_KEY only. */
export function liveModel(
  baseUrl: string,
  model: string,
  apiKey = process.env.EVAL_API_KEY,
): EvalModel {
  const url = checkLiveUrl(baseUrl);
  return async ({ prompt, seed }) => {
    const res = await fetch(
      `${url.toString().replace(/\/$/, '')}/chat/completions`,
      {
        method: 'POST',
        redirect: 'error',
        headers: {
          'content-type': 'application/json',
          ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({
          model,
          temperature: 0,
          seed,
          max_tokens: 400,
          messages: [{ role: 'user', content: prompt }],
        }),
        signal: AbortSignal.timeout(120_000),
      },
    );
    if (!res.ok) throw new Error(`live endpoint returned ${res.status}`);
    const body = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    return body.choices?.[0]?.message?.content ?? '';
  };
}

/** Run the suites against a live endpoint and store the record, keyed by endpoint profile id. */
export async function runLiveAndStore(o: {
  baseUrl: string;
  model: string;
  profile: string;
  seed?: number;
  out?: string;
  apiKey?: string;
}): Promise<{ record: EvalRecord; path: string }> {
  const record = await runEval(liveModel(o.baseUrl, o.model, o.apiKey), {
    mode: 'live',
    endpointProfileId: o.profile,
    modelName: o.model,
    seed: o.seed,
  });
  const path = o.out ?? `eval-records/${o.profile}.json`;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`);
  return { record, path };
}
