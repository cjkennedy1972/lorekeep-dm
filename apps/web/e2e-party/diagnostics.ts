import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Page, TestInfo } from '@playwright/test';

// Failure evidence for the party specs. Every helper here only observes: no assertion, timeout, or
// socket behaviour changes. Nothing recorded is a credential: frames keep only their type and seq, the
// socket URL (which carries the ws ticket) is never read, and anything that is attached is scrubbed.

export type TraceEvent =
  | { t: number; dir: 'recv' | 'sent'; type: string | null; seq: number | null }
  | {
      t: number;
      socket: number;
      ev: 'open' | 'close';
      code?: number;
      reason?: string;
    };

/** The part of a seat view that the diagnostics need. The views' own fields are not required here. */
export type SeatView = {
  label: string;
  entityId: string;
  mintStatus: number;
  page: Page;
  trace: TraceEvent[];
};

const MAX_TRACE = 400;
const MAX_TEXT = 4096;
const MAX_REASON = 120;
const MAX_ERROR = 2000;

/**
 * Runs in the page before any app script. Records each WebSocket's open and close (code and reason) into
 * `window.__e2eTrace`. Playwright's websocket event has no close code, so this wraps the constructor. The
 * wrapper keeps the native prototype and statics, and it never reads the URL.
 */
export const SOCKET_HOOK = `(() => {
  const Native = window.WebSocket;
  const log = (window.__e2eTrace = []);
  let count = 0;
  function TracedWebSocket(...args) {
    const ws = new Native(...args);
    const socket = count++;
    ws.addEventListener('open', () => log.push({ t: Date.now(), socket, ev: 'open' }));
    ws.addEventListener('close', (event) =>
      log.push({ t: Date.now(), socket, ev: 'close', code: event.code, reason: String(event.reason).slice(0, ${MAX_REASON}) }),
    );
    return ws;
  }
  TracedWebSocket.prototype = Native.prototype;
  for (const key of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']) TracedWebSocket[key] = Native[key];
  window.WebSocket = TracedWebSocket;
})();`;

/** Type and seq only. Payloads, tokens, and the rest of the frame are never kept. */
function frameMeta(payload: string | Buffer): {
  type: string | null;
  seq: number | null;
} {
  if (typeof payload !== 'string') return { type: 'binary', seq: null };
  try {
    const frame = JSON.parse(payload) as {
      type?: unknown;
      seq?: unknown;
      payload?: unknown;
    };
    const inner =
      typeof frame.payload === 'object' && frame.payload !== null
        ? (frame.payload as { seq?: unknown })
        : undefined;
    return {
      type: typeof frame.type === 'string' ? frame.type : null,
      seq:
        typeof frame.seq === 'number'
          ? frame.seq
          : typeof inner?.seq === 'number'
            ? inner.seq
            : null,
    };
  } catch {
    return { type: 'non-json', seq: null };
  }
}

/** Starts the node-side frame log for a page. Call before the page navigates. */
export function startSeatTrace(page: Page): TraceEvent[] {
  const trace: TraceEvent[] = [];
  const push =
    (dir: 'recv' | 'sent') => (event: { payload: string | Buffer }) =>
      trace.push({ t: Date.now(), dir, ...frameMeta(event.payload) });
  page.on('websocket', (socket) => {
    socket.on('framereceived', push('recv'));
    socket.on('framesent', push('sent'));
  });
  return trace;
}

/** Replaces every known secret with a marker. Structural fields (ids, path) are not secrets and are left alone. */
function redactSecrets(text: string, secrets: string[]): string {
  let out = text;
  for (const secret of secrets)
    out = out.split(secret).join('[redacted:secret]');
  return out;
}

/** Free text (snapshot, body text, error, close reason) also loses anything that looks like an opaque token. */
function scrub(text: string, secrets: string[]): string {
  return redactSecrets(text, secrets).replace(
    /[A-Za-z0-9_-]{32,}/g,
    '[redacted:opaque]',
  );
}

/**
 * Writes the attachment into the test's output directory and attaches that file. A body-only attachment is
 * not written to test-results, so the CI artifact (which uploads test-results) would miss it.
 */
async function attachFile(
  info: TestInfo,
  name: string,
  body: string,
  contentType: string,
) {
  const path = info.outputPath(name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
  await info.attach(name, { path, contentType });
}

type Evidence = {
  view: SeatView;
  url: string;
  trackers: number;
  snapshot: string;
  text: string;
  sockets: TraceEvent[];
  localSecrets: string[];
};

async function gather(view: SeatView): Promise<Evidence> {
  const { page } = view;
  const evidence: Evidence = {
    view,
    url: '',
    trackers: -1,
    snapshot: '',
    text: '',
    sockets: [],
    localSecrets: [],
  };
  try {
    evidence.url = new URL(page.url()).pathname; // path only: the query string can carry a ticket
  } catch {
    evidence.url = '(unavailable)';
  }
  try {
    evidence.trackers = await page
      .getByRole('list', { name: 'Initiative tracker' })
      .count();
  } catch {
    // The page may already be closed; the other evidence still gets attached.
  }
  try {
    evidence.snapshot = (
      await page.locator('body').ariaSnapshot({ timeout: 5_000 })
    ).slice(0, MAX_TEXT);
  } catch (error) {
    evidence.snapshot = `(aria snapshot unavailable: ${String(error).slice(0, 200)})`;
  }
  try {
    evidence.text = (
      await page.evaluate(() => document.body?.innerText ?? '')
    ).slice(0, MAX_TEXT);
  } catch {
    evidence.text = '(body text unavailable)';
  }
  try {
    evidence.sockets = await page.evaluate(
      () =>
        (window as unknown as { __e2eTrace?: TraceEvent[] }).__e2eTrace ?? [],
    );
  } catch {
    // Page closed or navigated away: no page-side socket events.
  }
  try {
    evidence.localSecrets = await page.evaluate(() => {
      const values: string[] = [];
      for (let i = 0; i < localStorage.length; i += 1) {
        const key = localStorage.key(i) ?? '';
        if (/resume|token|ticket/i.test(key))
          values.push(localStorage.getItem(key) ?? '');
      }
      return values;
    });
  } catch {
    // No storage access: the scrub still covers the state-file tokens.
  }
  return evidence;
}

/**
 * Attaches, for every seat, the page evidence and the ordered socket timeline, plus the error. Attachments
 * are capped: the timeline keeps its last MAX_TRACE events. Scrubbing runs over all attachments, using the
 * secrets from `knownSecrets` and the resume tokens read from each page's storage.
 */
export async function attachSeatDiagnostics(
  info: TestInfo,
  views: SeatView[],
  error: unknown,
  knownSecrets: string[],
) {
  const evidence = await Promise.all(views.map(gather));
  const secrets = [
    ...new Set([...knownSecrets, ...evidence.flatMap((e) => e.localSecrets)]),
  ].filter((secret) => secret.length >= 16);

  const message = error instanceof Error ? error.message : String(error);
  await attachFile(
    info,
    'party-diagnostics-error.txt',
    scrub(message.slice(0, MAX_ERROR), secrets),
    'text/plain',
  );

  for (const e of evidence) {
    const merged = [...e.view.trace, ...e.sockets].sort((a, b) => a.t - b.t);
    const timeline = merged
      .slice(-MAX_TRACE)
      .map((event) =>
        'reason' in event && event.reason !== undefined
          ? { ...event, reason: scrub(event.reason, secrets) }
          : event,
      );
    const sockets = new Set(
      merged.flatMap((event) => ('socket' in event ? [event.socket] : [])),
    );
    const summary = {
      seat: e.view.label,
      entityId: e.view.entityId,
      mintSeatResumeStatus: e.view.mintStatus,
      path: e.url,
      initiativeTrackersVisible: e.trackers,
      socketsOpened: sockets.size,
      frames: {
        received: e.view.trace.filter((x) => 'dir' in x && x.dir === 'recv')
          .length,
        sent: e.view.trace.filter((x) => 'dir' in x && x.dir === 'sent').length,
      },
      timelineEventsDropped: merged.length - timeline.length,
    };
    const body = redactSecrets(
      JSON.stringify(
        {
          summary,
          timeline,
          snapshot: scrub(e.snapshot, secrets),
          bodyText: scrub(e.text, secrets),
        },
        null,
        1,
      ),
      secrets,
    );
    await attachFile(
      info,
      `party-diagnostics-${e.view.label}.json`,
      body,
      'application/json',
    );
  }
}
