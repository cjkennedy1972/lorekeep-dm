import { allowInputGate } from '../support/allowInputGate.js';
import { rleEncode } from '@game/schema';
import adventure01 from '../../../../packages/engine/adventures/01/adventure.json' with { type: 'json' };
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import WebSocket from 'ws';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/app.js';
import { createSession } from '../../src/accounts/sessions.js';
import { installGateway } from '../../src/gateway/ws.js';
import { ConnectionRegistry } from '../../src/gateway/connections.js';
import { issueTicket } from '../../src/gateway/tickets.js';
import { hashToken } from '../../src/accounts/signup.js';
import { Persistence } from '../../src/persistence/index.js';
import { RoomRegistry } from '../../src/room/registry.js';
import { SessionLease } from '../../src/room/lease.js';
import { ProductionSoloTurnRunner } from '../../src/room/productionTurnRunner.js';
import { EncounterStartRejectionBudget } from '../../src/dm/encounters.js';
import { LlmEndpointError } from '../../src/llm/adapter.js';
import type {
  LlmAdapter,
  LlmChunk,
  LlmRequest,
} from '../../src/llm/adapter.js';
import { scriptedDm } from '../room/scriptedDm.js';
import type { RoomCombatState } from '../../src/room/combat.js';
import {
  bootstrapped,
  hero,
  placed,
  preCombatGame,
} from '../room/combatFixtures.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL required');

type Wire = { seq: number; type: string; payload?: Record<string, unknown> };
const accountIds: string[] = [];
const sessionIds: string[] = [];
const saved = {
  mode: process.env.LLM_FIXTURE_MODE,
  env: process.env.NODE_ENV,
};
let db: Pool;
let stack: Stack | undefined;

/** One server "process": registry + gateway. `restart` drops it (killing in-memory Rooms) and boots another. */
class Stack {
  private constructor(
    readonly rooms: RoomRegistry,
    readonly app: ReturnType<typeof createApp>,
    readonly base: string,
    readonly requests: LlmRequest[],
  ) {}
  static async boot(
    node: string,
    options: {
      adapter?: LlmAdapter;
      endpointAllowsMature?: boolean;
      storyCombatEnabled?: boolean;
      rejectionBudget?: EncounterStartRejectionBudget;
      adventureData?: unknown;
    } = {},
  ): Promise<Stack> {
    const requests: LlmRequest[] = [];
    const runner = new ProductionSoloTurnRunner(
      db,
      undefined,
      'strict',
      'unused.ndjson',
      options.adapter ?? scriptedDm(requests),
      true,
      options.endpointAllowsMature ?? false,
      undefined,
      undefined,
      options.storyCombatEnabled,
      options.rejectionBudget,
      options.adventureData,
    );
    const rooms = new RoomRegistry(
      new Persistence(db),
      new SessionLease(db),
      node,
      600_000,
      60_000,
      runner,
    );
    const connections = new ConnectionRegistry(db);
    const app = createApp(db, {
      inputGate: allowInputGate,
      rooms,
      connections,
    });
    installGateway(app, db, rooms, connections, 300);
    const base = await app.listen({ host: '127.0.0.1', port: 0 });
    return new Stack(rooms, app, base, requests);
  }
  async stop() {
    await this.rooms.drain();
    await this.app.close();
  }
}

class Client {
  log: Wire[] = [];
  static resumeTokens = new Map<string, string>();
  private constructor(
    readonly ws: WebSocket,
    private readonly accountId: string,
    private readonly tableId: string,
  ) {
    ws.on('message', (data) => {
      const frame = JSON.parse(data.toString()) as Wire;
      this.log.push(frame);
      if (frame.type === 'SeatResumeChallenge')
        ws.send(
          JSON.stringify({
            type: 'ResumeSeat',
            payload: {
              resumeToken: Client.resumeTokens.get(`${tableId}:${accountId}`),
            },
          }),
        );
      if (
        frame.type === 'SeatAuthenticated' &&
        typeof frame.payload?.resumeToken === 'string'
      )
        Client.resumeTokens.set(
          `${this.tableId}:${accountId}`,
          frame.payload.resumeToken,
        );
      if (frame.type === 'StateSync')
        ws.send(
          JSON.stringify({
            type: 'StateSyncAck',
            actionId: randomUUID(),
            lastSeq: frame.seq,
            payload: { seq: frame.seq },
          }),
        );
    });
  }
  static async open(
    s: Stack,
    user: { id: string; token: string },
    table: string,
  ) {
    const ticket = await issueTicket(db, user.id, table, hashToken(user.token));
    const ws = new WebSocket(
      `${s.base.replace('http', 'ws')}/ws?ticket=${ticket}`,
      {
        origin: s.base,
      },
    );
    const client = new Client(ws, user.id, table);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
      ws.once('close', () => reject(new Error('socket closed')));
    });
    await client.until((m) => m.type === 'StateSync', 0);
    return client;
  }
  /** Resolves with the first message at or after `from` that matches. Register by marking `log.length` before sending. */
  async until(
    match: (m: Wire) => boolean,
    from: number,
    timeoutMs = 8000,
  ): Promise<Wire> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const hit = this.log.slice(from).find(match);
      if (hit) return hit;
      if (Date.now() > deadline)
        throw new Error(
          `timed out; saw ${this.log
            .slice(from)
            .map(
              (m) => `${m.type}${m.payload?.code ? ':' + m.payload.code : ''}`,
            )
            .join(',')}`,
        );
      await new Promise((r) => setTimeout(r, 10));
    }
  }
  say(text: string) {
    this.ws.send(
      JSON.stringify({
        type: 'PlayerAction',
        actionId: randomUUID(),
        lastSeq: 0,
        payload: { text },
      }),
    );
  }
  private lastSent = 0;
  /** Sends a combat command and resolves with its outcome: the next tracker, or the Error for that action. */
  async command(
    payload: Record<string, unknown>,
    retries = 200,
  ): Promise<Wire> {
    let rateLimited = 0;
    for (let attempt = 0; attempt < retries; attempt++) {
      // Leave headroom beneath the gateway's 10/s per-socket message limit.
      const wait = this.lastSent + 120 - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      this.lastSent = Date.now();
      const actionId = randomUUID();
      const mark = this.log.length;
      this.ws.send(
        JSON.stringify({
          type: 'CombatCommand',
          actionId,
          lastSeq: 0,
          payload,
        }),
      );
      const expectedType =
        payload.command === 'options' ? 'CombatOptions' : 'CombatTracker';
      const reply = await this.until(
        (m) =>
          m.type === expectedType ||
          // The first flood gate (ws.ts, before the actionId is parsed) replies
          // RATE_LIMITED without an actionId; the second gate echoes it.
          (m.type === 'Error' &&
            (m.payload?.actionId === actionId ||
              (m.payload?.code === 'RATE_LIMITED' &&
                m.payload?.actionId === undefined))),
        mark,
      );
      // Admission rejects while the DM narrates the previous resolved turn
      // (phase `narrating`); retry Room admission after a short backoff.
      if (reply.payload?.code === 'narration-in-progress') {
        // A completion frame can race the rejected command; retry against Room
        // admission itself instead of waiting for a frame that may already have arrived.
        await new Promise((r) => setTimeout(r, 250));
        continue;
      }
      // RATE_LIMITED is rejected before the Room sees the command, so resending is safe.
      // Back off long enough for the per-socket bucket (10/s refill) to recover.
      if (reply.payload?.code === 'RATE_LIMITED') {
        // A real limiter regression would rate-limit every attempt, so cap the
        // tolerated backoffs and name the cause instead of "never finished narrating".
        if (++rateLimited > 5)
          throw new Error(
            `RATE_LIMITED ${rateLimited} times sending ${JSON.stringify(payload)}`,
          );
        console.warn(`combat command RATE_LIMITED (backoff #${rateLimited})`);
        await new Promise((r) => setTimeout(r, 300));
        continue;
      }
      return reply;
    }
    throw new Error(
      `DM never finished narrating (${rateLimited} RATE_LIMITED backoffs)`,
    );
  }
  last<T = Record<string, unknown>>(type: string): T {
    return [...this.log].reverse().find((m) => m.type === type)?.payload as T;
  }
  close() {
    this.ws.close();
  }
}

function forcedEncounterStartDm(encounterId: string): LlmAdapter {
  let calls = 0;
  return {
    capabilities: () => ({
      streaming: true,
      nativeTools: true,
      jsonSchema: true,
    }),
    probe: async () => true,
    async *complete() {
      calls++;
      if (calls === 1) {
        yield {
          type: 'tool-call',
          id: `forced-start-${calls}`,
          name: 'start_combat',
          arguments: { encounterId },
        } as LlmChunk;
      } else {
        yield { type: 'text', delta: 'The encounter remains ahead.' };
      }
    },
  };
}

function authoredEncounterDm(
  requests: LlmRequest[],
  encounterId: string,
  calls = 1,
  extraArgs: Record<string, unknown> = {},
): LlmAdapter {
  return {
    capabilities: () => ({
      streaming: true,
      nativeTools: true,
      jsonSchema: true,
    }),
    probe: async () => true,
    async *complete(request: LlmRequest) {
      requests.push(request);
      const hasToolResult = request.messages.some(
        (message) => message.role === 'tool',
      );
      const startCombatOffered = request.tools?.some(
        (tool) => tool.name === 'start_combat',
      );
      const chunks: LlmChunk[] =
        !startCombatOffered || hasToolResult
          ? [{ type: 'text', delta: 'The scene changes.' }]
          : Array.from({ length: calls }, (_, index) => ({
              type: 'tool-call' as const,
              id: `authored-start-${index}`,
              name: 'start_combat',
              arguments: { encounterId, ...extraArgs },
            }));
      for (const chunk of chunks) yield chunk;
    },
  };
}

function combatIntentRetryDm(
  firstTool: { name: string; arguments: Record<string, unknown> },
  requests: LlmRequest[],
  firstNarration: string,
): LlmAdapter {
  let calls = 0;
  return {
    capabilities: () => ({
      streaming: true,
      nativeTools: true,
      jsonSchema: true,
    }),
    probe: async () => true,
    async *complete(request: LlmRequest) {
      requests.push(request);
      calls++;
      if (calls === 1) {
        yield {
          type: 'tool-call',
          id: `combat-intent-${calls}`,
          name: firstTool.name,
          arguments: firstTool.arguments,
        } as LlmChunk;
      } else if (calls === 2) {
        yield { type: 'text', delta: firstNarration };
      } else {
        yield {
          type: 'text',
          delta: 'The encounter is now properly resolved.',
        };
      }
    },
  };
}

async function newUser() {
  const id = randomUUID();
  await db.query(
    `INSERT INTO accounts(id,email,password_hash,display_name,status,is_adult,age_checked_at,terms_version,terms_accepted_at) VALUES($1,$2,'hash','Aria','active',true,now(),'v1',now())`,
    [id, `${id}@example.test`],
  );
  accountIds.push(id);
  return { id, token: await createSession(db, id, 'combat-test') };
}
/** A table whose persisted snapshot already holds `game` (optionally with combat in flight), loaded by a fresh process. */
async function seedTable(
  s: Stack,
  owner: { id: string },
  game: (account: string) => Record<string, unknown>,
  adventure?: { id: string; sceneId: string },
) {
  const table = randomUUID();
  await db.query(
    "INSERT INTO sessions(id,owner_account_id,name,mode) VALUES($1,$2,$3,'solo')",
    [table, owner.id, 'Crypt'],
  );
  sessionIds.push(table);
  if (adventure)
    await db.query('UPDATE sessions SET adventure_id=$2 WHERE id=$1', [
      table,
      adventure.id,
    ]);
  const room = await s.rooms.get(table);
  const resumeToken = await room.seat(owner.id, 'Aria');
  if (resumeToken) Client.resumeTokens.set(`${table}:${owner.id}`, resumeToken);
  const gameState = game(owner.id);
  await room.persistGameState({
    ...gameState,
    ...(adventure ? { sceneId: adventure.sceneId } : {}),
  });
  return table;
}
const preCombat = (account: string) => {
  const g = preCombatGame();
  return { ...g, characters: { [account]: hero } };
};
const savedGame = async (table: string) =>
  (await new Persistence(db).loadLatest(table)).snapshot?.state as {
    gameState: {
      combatRoom?: RoomCombatState;
      combatActors?: Record<string, string>;
      characters?: Record<string, typeof hero>;
      gameEngine?: { combat?: { initiative: unknown[] } };
    };
    actionIds: string[];
  };
const storedTypes = async (table: string) =>
  (
    await db.query<{ type: string; payload: Record<string, unknown> }>(
      'SELECT type,payload FROM events WHERE session_id=$1 ORDER BY seq',
      [table],
    )
  ).rows;

/**
 * Starts combat on call 1. With `refuseOnCall`, that call throws an endpoint refusal and the
 * retry's start_combat is the call after it; every other call narrates.
 */
function combatStartDm(refuseOnCall?: number): {
  adapter: LlmAdapter;
  calls: () => number;
} {
  let calls = 0;
  const adapter: LlmAdapter = {
    capabilities: () => ({
      streaming: true,
      nativeTools: true,
      jsonSchema: true,
    }),
    probe: async () => true,
    async *complete() {
      calls += 1;
      if (calls === refuseOnCall)
        throw new LlmEndpointError('endpoint-refusal', 'refused');
      const startCall =
        calls === 1 ||
        (refuseOnCall !== undefined && calls === refuseOnCall + 1);
      if (startCall) {
        yield {
          type: 'tool-call',
          id: `call_start_${calls}`,
          name: 'start_combat',
          arguments: {
            enemies: [{ monsterId: 'srd:monster/goblin-minion', count: 2 }],
            ambushSide: 'party',
          },
        } as LlmChunk;
        return;
      }
      yield { type: 'text', delta: 'Steel rings out across the crypt.' };
    },
  };
  return { adapter, calls: () => calls };
}

function combatMoveRetryDm(refuseFirstAttempt: boolean): LlmAdapter {
  let calls = 0;
  return {
    capabilities: () => ({
      streaming: true,
      nativeTools: true,
      jsonSchema: true,
    }),
    probe: async () => true,
    async *complete() {
      calls += 1;
      if (refuseFirstAttempt && calls === 2)
        throw new LlmEndpointError('endpoint-refusal', 'refused');
      if (calls === 1 || (refuseFirstAttempt && calls === 3)) {
        yield {
          type: 'tool-call',
          id: `move-${calls}`,
          name: 'move_to',
          arguments: {
            entityId: 'ent_aria',
            targetRef: 'mk_entrance',
            mode: 'within',
          },
        } as LlmChunk;
        return;
      }
      yield { type: 'text', delta: 'Aria moves into position.' };
    },
  };
}

beforeAll(async () => {
  process.env.NODE_ENV = 'test';
  process.env.LLM_FIXTURE_MODE = 'strict';
  db = new Pool({ connectionString: databaseUrl });
});
afterAll(async () => {
  await stack?.stop();
  for (const id of sessionIds) await db.query('SELECT purge_session($1)', [id]);
  for (const id of accountIds)
    await db.query('DELETE FROM accounts WHERE id=$1', [id]);
  await db.end();
  if (saved.mode === undefined) delete process.env.LLM_FIXTURE_MODE;
  else process.env.LLM_FIXTURE_MODE = saved.mode;
  if (saved.env === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = saved.env;
}, 60_000);

describe('Room combat over the websocket (real Room, Postgres, scripted DM)', () => {
  it('covers X-card, pause/resume, report, and double rewind in one recorded room session', async () => {
    stack = await Stack.boot('safety-controls-and-rewind');
    const host = await newUser();
    const guest = await newUser();
    const table = await seedTable(stack, host, preCombat);
    const guestToken = await (
      await stack.rooms.get(table)
    ).seat(guest.id, 'Guest');
    if (guestToken) Client.resumeTokens.set(`${table}:${guest.id}`, guestToken);
    const h = await Client.open(stack, host, table);
    const g = await Client.open(stack, guest, table);

    const send = (client: Client, type: string, payload: object) => {
      const actionId = randomUUID();
      client.ws.send(JSON.stringify({ type, actionId, lastSeq: 0, payload }));
      return actionId;
    };
    try {
      const hostBeforeFlag = h.log.length;
      const guestBeforeFlag = g.log.length;
      send(g, 'XCard', {});
      const [hostFlag, guestFlag] = await Promise.all([
        h.until((m) => m.type === 'SafetyFlag', hostBeforeFlag),
        g.until((m) => m.type === 'SafetyFlag', guestBeforeFlag),
      ]);
      expect(hostFlag.payload).toEqual({ kind: 'x-card' });
      expect(guestFlag.payload).toEqual({ kind: 'x-card' });
      expect(
        JSON.stringify([hostFlag.payload, guestFlag.payload]),
      ).not.toContain(guest.id);

      const pausedFrom = h.log.length;
      send(g, 'PauseTable', { paused: true });
      await h.until(
        (m) =>
          m.type === 'StateSync' &&
          (m.payload?.state as { paused?: boolean }).paused === true,
        pausedFrom,
      );
      const guestResumeFrom = g.log.length;
      const guestResumeId = send(g, 'PauseTable', { paused: false });
      const guestResumeError = await g.until(
        (m) => m.type === 'Error' && m.payload?.actionId === guestResumeId,
        guestResumeFrom,
      );
      expect(guestResumeError.payload?.code).toBe('NOT_HOST');
      const resumedFrom = h.log.length;
      send(h, 'PauseTable', { paused: false });
      await h.until(
        (m) =>
          m.type === 'StateSync' &&
          (m.payload?.state as { paused?: boolean }).paused !== true,
        resumedFrom,
      );

      const narrationFrom = h.log.length;
      h.say('START-COMBAT');
      const narration = await h.until(
        (m) => m.type === 'NarrationCompleted',
        narrationFrom,
      );
      const report = await fetch(`${stack.base}/api/rooms/${table}/reports`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: stack.base,
          cookie: `sid=${guest.token}`,
        },
        body: JSON.stringify({
          messageRef: narration.seq,
          category: 'other',
          reason: 'Scripted safety acceptance report',
        }),
      });
      expect(report.status).toBe(202);
      expect(await report.json()).toEqual({ received: true });
      const storedReport = await db.query(
        'SELECT 1 FROM message_reports WHERE session_id=$1 AND message_seq=$2 AND reporter_account_id=$3',
        [table, narration.seq, guest.id],
      );
      expect(storedReport.rowCount).toBe(1);

      const firstRewindFrom = h.log.length;
      send(h, 'RewindTurn', {});
      await h.until((m) => m.type === 'TurnReverted', firstRewindFrom);
      const secondRewindFrom = h.log.length;
      const secondRewindId = send(h, 'RewindTurn', {});
      const rejected = await h.until(
        (m) => m.type === 'Error' && m.payload?.actionId === secondRewindId,
        secondRewindFrom,
      );
      expect(rejected.payload).toMatchObject({
        code: 'REWIND_REFUSED',
        message:
          'Only one rewind per resolved turn; let the next turn resolve first.',
      });
    } finally {
      h.close();
      g.close();
    }
  }, 30_000);

  it('validates authored encounter keys through the production turn route', async () => {
    const key = 'encounter-e2-lookouts';
    const validRequests: LlmRequest[] = [];
    stack = await Stack.boot('adr038-valid-route', {
      adapter: authoredEncounterDm(validRequests, key),
      storyCombatEnabled: true,
    });
    const user = await newUser();
    const validTable = await seedTable(
      stack,
      user,
      () => ({ ...preCombatGame(hero), characters: { [user.id]: hero } }),
      {
        id: 'adventure:01-hollow-under-marrowfell',
        sceneId: 'scene-warren-gallery',
      },
    );
    const client = await Client.open(stack, user, validTable);
    try {
      const from = client.log.length;
      client.say('I advance toward the lookouts.');
      await client.until(
        (message) => message.type === 'CombatTracker',
        from,
        20_000,
      );
      await client.until(
        (message) => message.type === 'NarrationCompleted',
        from,
        20_000,
      );
      const committed = await savedGame(validTable);
      expect(committed.gameState.resolvedEncounters).toContain(key);
      expect(committed.gameState.combatRoom?.map).toBeDefined();
      expect(
        committed.gameState.combatRoom?.entities.find(
          (entity) => entity.team === 'enemies',
        )?.pos,
      ).toEqual({ x: 24, y: 5 });
      expect(
        validRequests[0]?.messages.map((message) => message.content).join(' '),
      ).toContain(key);
      expect(
        JSON.stringify(
          validRequests[0]?.tools?.find((tool) => tool.name === 'start_combat')
            ?.parameters,
        ),
      ).toContain('encounterId');
    } finally {
      client.close();
    }
    await stack.stop();

    const invalidRequests: LlmRequest[] = [];
    stack = await Stack.boot('adr038-cross-scene-route', {
      adapter: authoredEncounterDm(invalidRequests, key),
      storyCombatEnabled: true,
    });
    const otherUser = await newUser();
    const invalidTable = await seedTable(
      stack,
      otherUser,
      () => ({ ...preCombatGame(hero), characters: { [otherUser.id]: hero } }),
      {
        id: 'adventure:01-hollow-under-marrowfell',
        sceneId: 'scene-boss-hall',
      },
    );
    const rejectedClient = await Client.open(stack, otherUser, invalidTable);
    try {
      const from = rejectedClient.log.length;
      rejectedClient.say('I look for a way forward.');
      await rejectedClient.until(
        (message) => message.type === 'NarrationCompleted',
        from,
        20_000,
      );
      expect(
        rejectedClient.log.filter((message) => message.type === 'ToolRejected'),
      ).toHaveLength(1);
      expect(JSON.stringify(rejectedClient.log)).not.toContain(
        'encounter-not-in-scene',
      );
      const unchanged = await savedGame(invalidTable);
      expect(unchanged.gameState.combatRoom).toBeUndefined();
      expect(unchanged.gameState.resolvedEncounters).toBeUndefined();
      expect(JSON.stringify(invalidRequests)).toContain(
        'encounter-not-in-scene',
      );
    } finally {
      rejectedClient.close();
    }
    await stack.stop();

    const emptyRequests: LlmRequest[] = [];
    stack = await Stack.boot('adr038-no-encounter-route', {
      adapter: authoredEncounterDm(emptyRequests, key),
      storyCombatEnabled: true,
    });
    const emptyUser = await newUser();
    const emptyTable = await seedTable(
      stack,
      emptyUser,
      () => ({ ...preCombatGame(hero), characters: { [emptyUser.id]: hero } }),
      {
        id: 'adventure:01-hollow-under-marrowfell',
        sceneId: 'scene-marowfell-well',
      },
    );
    const emptyClient = await Client.open(stack, emptyUser, emptyTable);
    try {
      const from = emptyClient.log.length;
      emptyClient.say('I study the well.');
      await emptyClient.until(
        (message) => message.type === 'NarrationCompleted',
        from,
        20_000,
      );
      expect(
        emptyRequests[0]?.messages.map((message) => message.content).join(' '),
      ).not.toContain('start_combat');
      expect(
        (await savedGame(emptyTable)).gameState.combatRoom,
      ).toBeUndefined();
    } finally {
      emptyClient.close();
    }
    await stack.stop();

    const duplicateRequests: LlmRequest[] = [];
    stack = await Stack.boot('adr038-duplicate-route', {
      adapter: authoredEncounterDm(duplicateRequests, key, 2),
      storyCombatEnabled: true,
    });
    const duplicateUser = await newUser();
    const duplicateTable = await seedTable(
      stack,
      duplicateUser,
      () => ({
        ...preCombatGame(hero),
        characters: { [duplicateUser.id]: hero },
      }),
      {
        id: 'adventure:01-hollow-under-marrowfell',
        sceneId: 'scene-warren-gallery',
      },
    );
    const duplicateClient = await Client.open(
      stack,
      duplicateUser,
      duplicateTable,
    );
    try {
      const from = duplicateClient.log.length;
      duplicateClient.say('I advance toward the lookouts.');
      await duplicateClient.until(
        (message) => message.type === 'CombatTracker',
        from,
        20_000,
      );
      await duplicateClient.until(
        (message) => message.type === 'NarrationCompleted',
        from,
        20_000,
      );
      expect(
        duplicateClient.log.filter(
          (message) => message.type === 'ToolRejected',
        ),
      ).toHaveLength(1);
      expect(JSON.stringify(duplicateClient.log)).not.toMatch(
        /duplicate-call|turn-budget-exhausted/u,
      );
      const committed = await savedGame(duplicateTable);
      expect(committed.gameState.resolvedEncounters).toEqual([key]);
      expect(committed.gameState.combatRoom?.entities).toHaveLength(2);
      expect(duplicateRequests).toHaveLength(2);
    } finally {
      duplicateClient.close();
    }
  }, 90_000);

  it('reports narration when an offered encounter was not started', async () => {
    const telemetry = vi.spyOn(console, 'info').mockImplementation(() => {});
    const adapter: LlmAdapter = {
      capabilities: () => ({
        streaming: true,
        nativeTools: true,
        jsonSchema: true,
      }),
      probe: async () => true,
      async *complete() {
        yield { type: 'text', delta: 'The lookouts watch from above.' };
      },
    };
    stack = await Stack.boot('adr038-narration-without-start', {
      adapter,
      storyCombatEnabled: true,
    });
    const user = await newUser();
    const table = await seedTable(
      stack,
      user,
      (account) => ({
        ...preCombatGame(hero),
        characters: { [account]: hero },
      }),
      {
        id: 'adventure:01-hollow-under-marrowfell',
        sceneId: 'scene-warren-gallery',
      },
    );
    const client = await Client.open(stack, user, table);
    try {
      const from = client.log.length;
      client.say('I wait and listen.');
      await client.until(
        (message) => message.type === 'NarrationCompleted',
        from,
        20_000,
      );
      const events = telemetry.mock.calls
        .map(([value]) => String(value))
        .filter((value) => value.includes('CombatNarratedWithoutStart'))
        .map((value) => JSON.parse(value) as { encounterId?: string });
      expect(events).toContainEqual(
        expect.objectContaining({ encounterId: 'encounter-e2-lookouts' }),
      );
    } finally {
      client.close();
      telemetry.mockRestore();
    }
  }, 30_000);

  it('does not make a second model call for an ordinary turn with an offered encounter', async () => {
    let calls = 0;
    const adapter: LlmAdapter = {
      capabilities: () => ({
        streaming: true,
        nativeTools: true,
        jsonSchema: true,
      }),
      probe: async () => true,
      async *complete() {
        calls++;
        yield { type: 'text', delta: 'The lookouts watch from above.' };
      },
    };
    stack = await Stack.boot('ordinary-turn-no-combat-retry', {
      adapter,
      storyCombatEnabled: true,
    });
    const user = await newUser();
    const table = await seedTable(
      stack,
      user,
      (account) => ({
        ...preCombatGame(hero),
        characters: { [account]: hero },
      }),
      {
        id: 'adventure:01-hollow-under-marrowfell',
        sceneId: 'scene-warren-gallery',
      },
    );
    const client = await Client.open(stack, user, table);
    try {
      const from = client.log.length;
      client.say('I wait and listen.');
      await client.until(
        (message) => message.type === 'NarrationCompleted',
        from,
        20_000,
      );
      expect(calls).toBe(1);
    } finally {
      client.close();
    }
  }, 30_000);

  it('retries exactly once after a failed hostile combat intent', async () => {
    const requests: LlmRequest[] = [];
    const adapter = combatIntentRetryDm(
      {
        name: 'attack',
        arguments: {
          attackerId: 'ent_aria',
          targetId: 'ent_goblin-minion_1',
          attackId: 'srd:weapon/longsword',
        },
      },
      requests,
      'The first attempt narrates before combat starts.',
    );
    stack = await Stack.boot('combat-intent-retry-once', {
      adapter,
      storyCombatEnabled: true,
    });
    const user = await newUser();
    const table = await seedTable(
      stack,
      user,
      (account) => ({
        ...preCombatGame(hero),
        characters: { [account]: hero },
      }),
      {
        id: 'adventure:01-hollow-under-marrowfell',
        sceneId: 'scene-warren-gallery',
      },
    );
    const client = await Client.open(stack, user, table);
    try {
      const from = client.log.length;
      client.say('I attack the lookouts.');
      await client.until(
        (message) => message.type === 'NarrationCompleted',
        from,
        20_000,
      );
      expect(requests).toHaveLength(3);
      expect(
        requests[2]?.messages.map((message) => message.content).join(' '),
      ).toContain('For a hostile-action encounter');
    } finally {
      client.close();
    }
  }, 30_000);

  it('does not retry after the server refuses a start_combat call', async () => {
    const requests: LlmRequest[] = [];
    const adapter = combatIntentRetryDm(
      {
        name: 'start_combat',
        arguments: { encounterId: 'encounter-not-offered' },
      },
      requests,
      'The lookouts remain ahead.',
    );
    stack = await Stack.boot('combat-start-refused-no-retry', {
      adapter,
      storyCombatEnabled: true,
    });
    const user = await newUser();
    const table = await seedTable(
      stack,
      user,
      (account) => ({
        ...preCombatGame(hero),
        characters: { [account]: hero },
      }),
      {
        id: 'adventure:01-hollow-under-marrowfell',
        sceneId: 'scene-warren-gallery',
      },
    );
    const client = await Client.open(stack, user, table);
    try {
      const from = client.log.length;
      client.say('I approach the lookouts.');
      await client.until(
        (message) => message.type === 'NarrationCompleted',
        from,
        20_000,
      );
      expect(
        client.log
          .slice(from)
          .some((message) => message.type === 'ToolRejected'),
      ).toBe(true);
      expect(requests).toHaveLength(2);
      expect(JSON.stringify(requests)).not.toContain(
        'For a hostile-action encounter',
      );
    } finally {
      client.close();
    }
  }, 30_000);

  it('discards narration from the failed first combat-intent attempt', async () => {
    const requests: LlmRequest[] = [];
    const adapter = combatIntentRetryDm(
      {
        name: 'attack',
        arguments: {
          attackerId: 'ent_aria',
          targetId: 'ent_goblin-minion_1',
          attackId: 'srd:weapon/longsword',
        },
      },
      requests,
      'FIRST_ATTEMPT_OUTPUT_MUST_NOT_ESCAPE',
    );
    stack = await Stack.boot('combat-retry-discards-first-output', {
      adapter,
      storyCombatEnabled: true,
    });
    const user = await newUser();
    const table = await seedTable(
      stack,
      user,
      (account) => ({
        ...preCombatGame(hero),
        characters: { [account]: hero },
      }),
      {
        id: 'adventure:01-hollow-under-marrowfell',
        sceneId: 'scene-warren-gallery',
      },
    );
    const client = await Client.open(stack, user, table);
    try {
      const from = client.log.length;
      client.say('I attack the lookouts.');
      const completed = await client.until(
        (message) => message.type === 'NarrationCompleted',
        from,
        20_000,
      );
      expect(String(completed.payload?.text ?? '')).toContain(
        'The encounter is now properly resolved.',
      );
      expect(JSON.stringify(client.log.slice(from))).not.toContain(
        'FIRST_ATTEMPT_OUTPUT_MUST_NOT_ESCAPE',
      );
    } finally {
      client.close();
    }
  }, 30_000);

  it.each([
    ['encounter-e2-lookouts', 'scene-warren-gallery', { x: 3, y: 5 }],
    ['encounter-e3-skarrik', 'scene-boss-hall', { x: 22, y: 20 }],
  ] as const)(
    'places the party on the authored marker for %s',
    async (encounterId, sceneId, expectedPos) => {
      stack = await Stack.boot(`party-marker-${encounterId}`, {
        adapter: authoredEncounterDm([], encounterId),
        storyCombatEnabled: true,
      });
      const user = await newUser();
      const table = await seedTable(
        stack,
        user,
        (account) => ({
          ...preCombatGame(hero),
          characters: { [account]: hero },
        }),
        { id: 'adventure:01-hollow-under-marrowfell', sceneId },
      );
      const client = await Client.open(stack, user, table);
      try {
        const from = client.log.length;
        client.say('I move toward the encounter.');
        await client.until(
          (message) => message.type === 'CombatTracker',
          from,
          20_000,
        );
        const saved = await savedGame(table);
        expect(
          saved.gameState.combatRoom?.entities.find(
            (entity) => entity.id === 'ent_aria',
          )?.pos,
        ).toEqual(expectedPos);
      } finally {
        client.close();
      }
    },
    30_000,
  );

  it('rejects an invalid party marker through the production runner without persisting combat state', async () => {
    const invalidAdventure = structuredClone(adventure01) as unknown as {
      encounters: Array<{ id: string; partySpawnMarkerId?: string }>;
    };
    invalidAdventure.encounters.find(
      (item) => item.id === 'encounter-e2-lookouts',
    )!.partySpawnMarkerId = 'missing-party-marker';
    stack = await Stack.boot('invalid-party-marker-production-runner', {
      adapter: forcedEncounterStartDm('encounter-e2-lookouts'),
      storyCombatEnabled: true,
      adventureData: invalidAdventure,
    });
    const user = await newUser();
    const table = await seedTable(
      stack,
      user,
      (account) => ({
        ...preCombatGame(hero),
        characters: { [account]: hero },
      }),
      {
        id: 'adventure:01-hollow-under-marrowfell',
        sceneId: 'scene-warren-gallery',
      },
    );
    const before = await savedGame(table);
    const client = await Client.open(stack, user, table);
    try {
      const from = client.log.length;
      client.say('I move toward the encounter.');
      await client.until(
        (message) => message.type === 'NarrationCompleted',
        from,
        20_000,
      );
      const after = await savedGame(table);
      expect(after.gameState.gameEngine).toEqual(before.gameState.gameEngine);
      expect(after.gameState.combatRoom).toBeUndefined();
      expect(
        (await storedTypes(table)).some(
          (event) => event.type === 'CombatStarted',
        ),
      ).toBe(false);
    } finally {
      client.close();
      await stack.stop();
      stack = undefined;
    }
  }, 30_000);

  it('rejects an encounter before commit when the authored map cannot fit the party', async () => {
    const alteredAdventure = structuredClone(adventure01) as unknown as {
      maps: Array<{
        mapId: string;
        w: number;
        h: number;
        palette: Array<{
          terrainId: string;
          moveCost: number;
          blocksMove: boolean;
          blocksSight: boolean;
          cover: string;
          elevation: number;
        }>;
        cells: number[];
        markers: Array<{ markerId: string; cell: { x: number; y: number } }>;
        zones: Array<{
          zoneId: string;
          kind: string;
          cells: Array<{ x: number; y: number }>;
        }>;
      }>;
    };
    const map = alteredAdventure.maps.find(
      (item) => item.mapId === 'adv01-warrens',
    )!;
    const partyCell = map.markers.find(
      (marker) => marker.markerId === 'mk_e2_party',
    )!.cell;
    const enemyCell = { x: partyCell.x + 1, y: partyCell.y };
    const e3PartyCell = map.markers.find(
      (marker) => marker.markerId === 'mk_e3_party',
    )!.cell;
    const e3EnemyCell = { x: e3PartyCell.x + 1, y: e3PartyCell.y };
    try {
      map.markers = map.markers.map((marker) =>
        marker.markerId === 'mk_e2_enemy'
          ? { ...marker, cell: enemyCell }
          : marker.markerId === 'mk_e3_enemy'
            ? { ...marker, cell: e3EnemyCell }
            : marker,
      );
      map.zones = map.zones.map((zone) =>
        zone.zoneId === 'zone-e2-party'
          ? { ...zone, cells: [partyCell] }
          : zone.zoneId === 'zone-e2-enemy'
            ? { ...zone, cells: [enemyCell] }
            : zone.zoneId === 'zone-e3-party'
              ? { ...zone, cells: [e3PartyCell] }
              : zone.zoneId === 'zone-e3-enemy'
                ? { ...zone, cells: [e3EnemyCell] }
                : zone,
      );
      const blockedIndex = map.palette.findIndex(
        (entry) => entry.terrainId === 'rubble',
      );
      map.palette[blockedIndex] = {
        ...map.palette[blockedIndex]!,
        blocksMove: true,
      };
      const grid = Array.from({ length: map.w * map.h }, () => blockedIndex);
      for (const cell of [partyCell, enemyCell, e3PartyCell, e3EnemyCell])
        grid[cell.y * map.w + cell.x] = 0;
      map.cells = rleEncode(grid);

      const requests: LlmRequest[] = [];
      stack = await Stack.boot('full-party-spawn-capacity', {
        adapter: authoredEncounterDm(requests, 'encounter-e2-lookouts'),
        storyCombatEnabled: true,
        adventureData: alteredAdventure,
      });
      const user = await newUser();
      const extra = { ...hero, id: 'ent_extra_party', name: 'Extra Party' };
      const table = await seedTable(
        stack,
        user,
        (account) => ({
          ...preCombatGame(hero),
          characters: { [account]: hero, 'other-account': extra },
          gameEngine: {
            ...preCombatGame(hero).gameEngine,
            actors: { [hero.id]: hero, [extra.id]: extra },
            hp: { [hero.id]: hero.hp.current, [extra.id]: extra.hp.current },
            ac: { [hero.id]: 12, [extra.id]: 12 },
          },
        }),
        {
          id: 'adventure:01-hollow-under-marrowfell',
          sceneId: 'scene-warren-gallery',
        },
      );
      const before = await savedGame(table);
      const client = await Client.open(stack, user, table);
      try {
        const from = client.log.length;
        client.say('I move toward the encounter.');
        await client.until(
          (message) => message.type === 'NarrationCompleted',
          from,
          20_000,
        );
        expect(
          requests[0]?.tools?.some((tool) => tool.name === 'start_combat'),
        ).toBe(true);
        const after = await savedGame(table);
        expect(after.gameState.gameEngine).toEqual(before.gameState.gameEngine);
        expect(after.gameState.combatRoom).toBeUndefined();
        expect(
          (await storedTypes(table)).some(
            (event) => event.type === 'CombatStarted',
          ),
        ).toBe(false);
      } finally {
        client.close();
      }
    } finally {
      await stack?.stop();
      stack = undefined;
    }
  }, 30_000);

  it('retries a refused mature start with fresh combat interception state', async () => {
    let calls = 0;
    const adapter: LlmAdapter = {
      capabilities: () => ({
        streaming: true,
        nativeTools: true,
        jsonSchema: true,
      }),
      probe: async () => true,
      async *complete() {
        calls += 1;
        if (calls === 2)
          throw new LlmEndpointError('endpoint-refusal', 'refused');
        if (calls === 1 || calls === 3) {
          yield {
            type: 'tool-call',
            id: `retry-start-${calls}`,
            name: 'start_combat',
            arguments: {
              encounterId:
                calls === 1 ? 'encounter-e1-rats' : 'encounter-e2-lookouts',
            },
          } as LlmChunk;
          return;
        }
        yield {
          type: 'text',
          delta: 'Steel rings out across the crypt.',
        } as LlmChunk;
      },
    };
    const retryBudget = new EncounterStartRejectionBudget(0);
    stack = await Stack.boot('adr038-refusal-retry-state', {
      adapter,
      storyCombatEnabled: true,
      endpointAllowsMature: true,
      rejectionBudget: retryBudget,
    });
    const user = await newUser();
    const table = await seedTable(
      stack,
      user,
      (account) => ({
        ...preCombatGame(hero),
        characters: { [account]: hero },
      }),
      {
        id: 'adventure:01-hollow-under-marrowfell',
        sceneId: 'scene-warren-gallery',
      },
    );
    await db.query(
      'UPDATE sessions SET moderation_verified=true, endpoint_allows_mature=true WHERE id=$1',
      [table],
    );
    const client = await Client.open(stack, user, table);
    try {
      const from = client.log.length;
      client.say('I advance toward the lookouts.');
      await client.until(
        (message) => message.type === 'CombatTracker',
        from,
        20_000,
      );
      await client.until(
        (message) => message.type === 'NarrationCompleted',
        from,
        20_000,
      );
      expect(calls).toBe(4);
      expect(
        client.log.some((message) => message.type === 'ToolRejected'),
      ).toBe(false);
      expect((await savedGame(table)).gameState.combatRoom).toBeDefined();
      expect(retryBudget.isWithdrawn(table, 'scene-warren-gallery')).toBe(
        false,
      );
    } finally {
      client.close();
      retryBudget.clearSession(table);
    }
  }, 30_000);

  it('rejects a freeform roster supplied beside a valid encounter key', async () => {
    stack = await Stack.boot('adr038-freeform-roster-rejected', {
      adapter: authoredEncounterDm([], 'encounter-e2-lookouts', 1, {
        enemies: [{ monsterId: 'srd:monster/goblin-minion', count: 8 }],
      }),
      storyCombatEnabled: true,
    });
    const user = await newUser();
    const table = await seedTable(
      stack,
      user,
      (account) => ({
        ...preCombatGame(hero),
        characters: { [account]: hero },
      }),
      {
        id: 'adventure:01-hollow-under-marrowfell',
        sceneId: 'scene-warren-gallery',
      },
    );
    const client = await Client.open(stack, user, table);
    try {
      const from = client.log.length;
      client.say('I advance toward the lookouts.');
      await client.until(
        (message) => message.type === 'NarrationCompleted',
        from,
        20_000,
      );
      expect(
        client.log.filter((message) => message.type === 'ToolRejected'),
      ).toHaveLength(1);
      const saved = await savedGame(table);
      expect(saved.gameState.combatRoom).toBeUndefined();
      expect(saved.gameState.resolvedEncounters).toBeUndefined();
    } finally {
      client.close();
    }
  }, 30_000);

  it('does not persist ADR state or charge the rejection budget on endpoint-error turns', async () => {
    let calls = 0;
    const adapter: LlmAdapter = {
      capabilities: () => ({
        streaming: true,
        nativeTools: true,
        jsonSchema: true,
      }),
      probe: async () => true,
      async *complete() {
        calls += 1;
        if (calls % 2 === 0)
          throw new LlmEndpointError('endpoint-error', 'offline');
        const turnNumber = Math.floor((calls - 1) / 2);
        yield {
          type: 'tool-call',
          id: `failed-start-${calls}`,
          name: 'start_combat',
          arguments: {
            encounterId:
              turnNumber % 2 === 0
                ? 'encounter-e2-lookouts'
                : 'encounter-e1-rats',
          },
        } as LlmChunk;
      },
    };
    const testBudget = new EncounterStartRejectionBudget(0);
    stack = await Stack.boot('adr038-endpoint-error-isolation', {
      adapter,
      storyCombatEnabled: true,
      rejectionBudget: testBudget,
    });
    const user = await newUser();
    const table = await seedTable(
      stack,
      user,
      (account) => ({
        ...preCombatGame(hero),
        characters: { [account]: hero },
      }),
      {
        id: 'adventure:01-hollow-under-marrowfell',
        sceneId: 'scene-warren-gallery',
      },
    );
    const client = await Client.open(stack, user, table);
    const telemetry = vi.spyOn(console, 'info').mockImplementation(() => {});
    try {
      for (let index = 0; index < 2; index++) {
        const from = client.log.length;
        client.say(`I investigate the hall, attempt ${index}.`);
        await client.until(
          (message) =>
            message.type === 'Error' && message.payload?.code === 'TURN_FAILED',
          from,
          20_000,
        );
      }
      const saved = await savedGame(table);
      expect(saved.gameState.resolvedEncounters).toBeUndefined();
      expect(saved.gameState.combatRoom).toBeUndefined();
      expect(saved.gameState).not.toHaveProperty('startedEncounter');
      expect(testBudget.isWithdrawn(table, 'scene-warren-gallery')).toBe(false);
      const calls = telemetry.mock.calls
        .map(([value]) => String(value))
        .filter((value) => value.includes('CombatStartToolCalled'));
      expect(calls.length).toBeGreaterThan(0);
      expect(calls.every((value) => !value.includes('encounter-e1-rats'))).toBe(
        true,
      );
    } finally {
      client.close();
      telemetry.mockRestore();
      testBudget.clearSession(table);
    }
  }, 30_000);

  it('start_combat populates the Room, monsters act, and a non-controller cannot accept an opportunity attack', async () => {
    const encounterKey = 'encounter-e2-lookouts';
    const combatRequests: LlmRequest[] = [];
    const adapter = authoredEncounterDm(combatRequests, encounterKey);
    stack = await Stack.boot('combat-full', {
      adapter,
      storyCombatEnabled: true,
    });
    const user = await newUser();
    const table = await seedTable(
      stack,
      user,
      () => ({ ...preCombatGame(hero), characters: { [user.id]: hero } }),
      {
        id: 'adventure:01-hollow-under-marrowfell',
        sceneId: 'scene-warren-gallery',
      },
    );
    await stack.stop();
    stack = await Stack.boot('combat-full-2', {
      adapter,
      storyCombatEnabled: true,
    });
    const client = await Client.open(stack, user, table);
    // A recovered seat is `returning` until ADR-031's full 10 s reconnect hold.
    await client.until(
      (message) =>
        message.type === 'PresenceChanged' &&
        message.payload?.presence === 'connected',
      0,
      15_000,
    );

    const mark = client.log.length;
    client.say('START-COMBAT');
    const started = await client.until((m) => m.type === 'CombatTracker', mark);
    expect(started.payload).toMatchObject({
      round: 1,
      activeEntityId: 'ent_aria',
    });
    expect(started.payload!.initiative[0].entityId).toBe('ent_aria');
    // Exact enemy HP never leaves the server: only a qualitative state.
    const goblin = started.payload!.entities.find(
      (e: unknown) => e.team === 'enemies',
    );
    expect(goblin).toMatchObject({ hpState: 'healthy' });
    expect(goblin).not.toHaveProperty('hp');
    await client.until((m) => m.type === 'NarrationCompleted', mark);
    expect(combatRequests.length).toBeGreaterThanOrEqual(1);
    const boot = await savedGame(table);
    expect(boot.gameState.combatActors).toEqual({ [user.id]: 'ent_aria' });
    expect(boot.gameState.combatRoom?.entities).toHaveLength(2);

    // Play the hero with the same options a client sees; kite once to provoke (and accept) an opportunity attack.
    let kited = false;
    let guard = 0;
    while (!client.last('CombatEnded') && guard++ < 60) {
      let tracker = client.last<unknown>('CombatTracker');
      if (tracker.ended) break;
      if (tracker.activeEntityId !== 'ent_aria') {
        await new Promise((r) => setTimeout(r, 25));
        continue;
      }
      const me = tracker.entities.find((e: unknown) => e.id === 'ent_aria');
      const foes = tracker.entities.filter(
        (e: unknown) => e.team === 'enemies' && e.hpState !== 'down' && !e.fled,
      );
      const reach = (a: unknown, b: unknown) =>
        Math.max(Math.abs(a.pos.x - b.pos.x), Math.abs(a.pos.y - b.pos.y));
      const reachFrom = (pos: unknown, entity: unknown) =>
        Math.max(
          Math.abs(pos.x - entity.pos.x),
          Math.abs(pos.y - entity.pos.y),
        );
      const nearest = [...foes].sort((a, b) => reach(me, a) - reach(me, b))[0];
      const optionsReply = await client.command({ command: 'options' });
      if (
        optionsReply.type === 'Error' &&
        optionsReply.payload?.code === 'not-your-turn'
      ) {
        // CombatTracker is a broadcast snapshot; the turn can advance while this
        // command is queued. Re-read it on the next loop before choosing an action.
        continue;
      }
      if (
        optionsReply.type === 'Error' &&
        optionsReply.payload?.code === 'reaction-window-open'
      ) {
        const prompt =
          client.last<Record<string, unknown>>('ReactionPromptOpen');
        if (!prompt?.reactionId)
          throw new Error('Pending reaction has no websocket prompt.');
        const reactionMark = client.log.length;
        const answer = await client.command({
          command: 'reaction',
          reactionId: prompt.reactionId,
          choice: 'take',
        });
        expect(answer).toMatchObject({
          type: 'Error',
          payload: { code: 'not-your-turn', message: 'It is not your turn.' },
        });
        const resolved = await client.until(
          (message) =>
            message.type === 'CombatEvents' &&
            message.payload?.events.some(
              (event: unknown) =>
                (event as { type?: string }).type === 'ReactionResolved',
            ),
          reactionMark,
          20_000,
        );
        expect(resolved.payload!.events).toContainEqual(
          expect.objectContaining({ type: 'ReactionResolved', used: false }),
        );
        continue;
      }
      if (optionsReply.type === 'Error')
        throw new Error(
          `options got Error code=${String(optionsReply.payload?.code)} message=${String(optionsReply.payload?.message)}; frames: ${client.log
            .map((m) => m.type + (m.payload?.code ? `:${m.payload.code}` : ''))
            .join(',')}`,
        );
      expect(optionsReply.type).toBe('CombatOptions');
      const opts = optionsReply.payload as Record<string, unknown>;
      const resources = tracker.resources.ent_aria;
      const area = (opts.areas as Record<string, unknown>[])
        .filter((a) => a.affected.some((x: unknown) => x.relation === 'enemy'))
        .sort((a, b) => b.affected.length - a.affected.length)[0];
      if (
        resources.action &&
        area &&
        !client.log.some(
          (m) =>
            m.type === 'CombatEvents' &&
            m.payload?.events.some((e: unknown) => e.type === 'SpellCast'),
        )
      ) {
        await client.command({
          command: 'cast',
          spellId: 'spell:burning-hands',
          slotLevel: 1,
          target: { kind: 'option', ref: area.optionId },
        });
      } else if (resources.action) {
        const hit = (opts.actions as Record<string, unknown>[]).find(
          (a) => a.kind === 'attack',
        );
        if (hit)
          await client.command({
            command: 'attack',
            targetId: hit.targetId,
            attackId: hit.attackId,
          });
      }
      tracker = client.last<unknown>('CombatTracker');
      if (client.last('CombatEnded')) break;
      if (nearest && reach(me, nearest) <= 1 && !kited) {
        const flee = (opts.actions as Record<string, unknown>[])
          .filter(
            (a) => a.kind === 'move' && reachFrom(a.destination, nearest) === 2,
          )
          .sort((a, b) => a.cost - b.cost)[0];
        if (flee) {
          kited = true;
          const before = client.log.length;
          await client.command({
            command: 'move',
            destination: flee.destination,
          });
          const prompt = await client.until(
            (m) => m.type === 'ReactionPromptOpen',
            before,
          );
          expect(prompt.payload).toMatchObject({
            reactorEntityId: expect.stringContaining('goblin'),
          });
          expect(prompt.payload).not.toHaveProperty('moverId');
          expect(prompt.payload).not.toHaveProperty('trigger');
          expect(prompt.payload!.timeoutMs).toBeLessThanOrEqual(15_000);
          const reactionMark = client.log.length;
          const answer = await client.command({
            command: 'reaction',
            reactionId: prompt.payload!.reactionId,
            choice: 'take',
          });
          expect(answer).toMatchObject({
            type: 'Error',
            payload: {
              code: 'not-your-turn',
              message: 'It is not your turn.',
            },
          });
          const resolved = await client.until(
            (message) =>
              message.type === 'CombatEvents' &&
              message.payload?.events.some(
                (event: unknown) =>
                  (event as { type?: string }).type === 'ReactionResolved',
              ),
            reactionMark,
            20_000,
          );
          expect(resolved.payload!.events).toContainEqual(
            expect.objectContaining({ type: 'ReactionResolved', used: false }),
          );
        }
      } else if (
        nearest &&
        reach(me, nearest) > 1 &&
        resources.movementRemaining > 0
      ) {
        const step = (opts.actions as Record<string, unknown>[])
          .filter((a) => a.kind === 'move')
          .sort(
            (a, b) =>
              reachFrom(a.destination, nearest) -
                reachFrom(b.destination, nearest) || a.cost - b.cost,
          )[0];
        if (step)
          await client.command({
            command: 'move',
            destination: step.destination,
          });
      }
      if (client.last('CombatEnded')) break;
      const open = client.last<unknown>('ReactionPromptOpen');
      tracker = client.last<unknown>('CombatTracker');
      if (tracker.activeEntityId === 'ent_aria' && !tracker.ended)
        await client.command({ command: 'end-turn' });
      void open;
    }
    const ended = await client.until((m) => m.type === 'CombatEnded', 0);
    expect(['party-victory', 'party-defeated', 'enemies-fled']).toContain(
      ended.payload!.outcome,
    );
    // The DM narrates after the engine decided.
    const mark2 = client.log.findIndex((m) => m.type === 'CombatEnded');
    await client.until((m) => m.type === 'NarrationCompleted', mark2);

    const types = (await storedTypes(table)).map((r) => r.type);
    expect(types).toEqual(
      expect.arrayContaining([
        'CombatStarted',
        'MonsterPolicy',
        'SpellCast',
        'CombatEnded',
      ]),
    );
    expect(
      (await storedTypes(table)).find((r) => r.type === 'ReactionResolved')!
        .payload,
    ).toMatchObject({ used: false });
    const end = await savedGame(table);
    expect(end.gameState.combatRoom?.ended?.outcome).toBe(
      ended.payload!.outcome,
    );
    expect(end.gameState.gameEngine?.combat?.initiative).toEqual([]);
    expect(end.gameState.characters![user.id]!.slots['1']).toEqual({
      max: 2,
      used: 1,
    });
    client.close();
  }, 60_000);

  it('kill and restart mid-combat resumes pending reaction state and rejects the non-controller', async () => {
    stack = await Stack.boot('combat-resume-1');
    const user = await newUser();
    const table = await seedTable(stack, user, (account) => {
      const b = bootstrapped();
      const state = placed(b.state, {
        ent_aria: { x: 7, y: 2 },
        'ent_goblin-minion_1': { x: 8, y: 2 },
        'ent_goblin-minion_2': { x: 12, y: 16 },
      });
      return {
        ...preCombatGame(),
        characters: { [account]: hero },
        combatActors: { [account]: 'ent_aria' },
        combatRoom: state,
      };
    });
    await stack.stop();
    stack = await Stack.boot('combat-resume-2');
    let client = await Client.open(stack, user, table);
    const mark = client.log.length;
    client.ws.send(
      JSON.stringify({
        type: 'CombatCommand',
        actionId: randomUUID(),
        lastSeq: 0,
        payload: { command: 'move', destination: { x: 7, y: 6 } },
      }),
    );
    const prompt = await client.until(
      (m) => m.type === 'ReactionPromptOpen',
      mark,
    );
    const before = (await savedGame(table)).gameState.combatRoom!;
    expect(before.pendingReaction).toBeDefined();
    const remaining = before.combat.resources.ent_aria!.movementRemaining;
    client.close();

    // kill -9: the process and its in-memory Room are gone; only Postgres remains
    await stack.stop();
    stack = await Stack.boot('combat-resume-3');
    client = await Client.open(stack, user, table);
    const resumed = await client.until(
      (m) =>
        m.type === 'ReactionPromptOpen' ||
        (m.type === 'CombatEvents' &&
          m.payload!.events.some(
            (event: unknown) =>
              (event as { type?: string }).type === 'ReactionResolved',
          )),
      0,
    );
    const stillPending = resumed.type === 'ReactionPromptOpen';
    if (stillPending)
      expect(resumed.payload!.reactionId).toBe(prompt.payload!.reactionId);
    else
      expect(resumed.payload!.events).toContainEqual(
        expect.objectContaining({
          type: 'ReactionResolved',
          choice: 'decline',
        }),
      );
    const tracker = await client.until((m) => m.type === 'CombatTracker', 0);
    expect(tracker.payload).toMatchObject({ activeEntityId: 'ent_aria' });
    expect(tracker.payload!.resources.ent_aria.movementRemaining).toBe(
      remaining,
    );

    const pendingBeforeAnswer = (await savedGame(table)).gameState.combatRoom!
      .pendingReaction;
    if (stillPending) {
      const answer = await client.command({
        command: 'reaction',
        reactionId: prompt.payload!.reactionId,
        choice: 'take',
      });
      expect(answer).toMatchObject({
        type: 'Error',
        payload: { code: 'not-your-turn', message: 'It is not your turn.' },
      });
      expect(
        (await savedGame(table)).gameState.combatRoom!.pendingReaction,
      ).toBeDefined();
    } else {
      expect(pendingBeforeAnswer).toBeUndefined();
    }
    client.close();
  }, 30_000);

  it('a reaction left unanswered across a restart still auto-declines from the persisted deadline', async () => {
    stack = await Stack.boot('combat-deadline-1');
    const user = await newUser();
    const table = await seedTable(stack, user, (account) => {
      const b = bootstrapped();
      const state = placed(b.state, {
        ent_aria: { x: 7, y: 4 },
        'ent_goblin-minion_1': { x: 8, y: 2 },
        'ent_goblin-minion_2': { x: 12, y: 16 },
      });
      return {
        ...preCombatGame(),
        characters: { [account]: hero },
        combatActors: { [account]: 'ent_aria' },
        combatRoom: {
          ...state,
          engineReactions: {},
          pendingReaction: {
            reactionId: 'ent_goblin-minion_1->ent_aria@7,4',
            entityId: 'ent_goblin-minion_1',
            trigger: 'opportunityAttack',
            moverId: 'ent_aria',
            deadlineAt: Date.now() - 1000, // expired while the server was down
          },
        },
      };
    });
    await stack.stop();
    stack = await Stack.boot('combat-deadline-2');
    await stack.rooms.get(table);
    const deadline = Date.now() + 5000;
    for (;;) {
      const game = (await savedGame(table)).gameState.combatRoom!;
      if (!game.pendingReaction) break;
      if (Date.now() > deadline) throw new Error('prompt never auto-declined');
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(
      (await storedTypes(table)).some(
        (r) => r.type === 'ReactionResolved' && r.payload.used === false,
      ),
    ).toBe(true);
  }, 20_000);

  it('rejects a message flood immediately with RATE_LIMITED instead of queueing it', async () => {
    stack = await Stack.boot('combat-flood');
    const user = await newUser();
    const table = await seedTable(stack, user, (account) => {
      const b = bootstrapped();
      return {
        ...preCombatGame(),
        characters: { [account]: hero },
        combatActors: { [account]: 'ent_aria' },
        combatRoom: b.state,
      };
    });
    const client = await Client.open(stack, user, table);
    const mark = client.log.length;
    for (let i = 0; i < 200; i++)
      client.ws.send(
        JSON.stringify({
          type: 'CombatCommand',
          actionId: randomUUID(),
          lastSeq: 0,
          payload: { command: 'options' },
        }),
      );
    await vi.waitFor(
      () =>
        expect(
          client.log
            .slice(mark)
            .filter(
              (m) => m.type === 'Error' && m.payload?.code === 'RATE_LIMITED',
            ).length,
        ).toBeGreaterThanOrEqual(150),
      { timeout: 2000 },
    );
    client.close();
  }, 20_000);

  it('keeps character keys as account ids when a refused mature start is retried', async () => {
    const { adapter, calls } = combatStartDm(2);
    stack = await Stack.boot('retry-refused-character-keys', {
      adapter,
      endpointAllowsMature: true,
    });
    const user = await newUser();
    const table = await seedTable(stack, user, preCombat);
    await db.query(
      'UPDATE sessions SET moderation_verified=true, endpoint_allows_mature=true WHERE id=$1',
      [table],
    );
    const client = await Client.open(stack, user, table);
    try {
      const from = client.log.length;
      client.say('I advance toward the lookouts.');
      await client.until((m) => m.type === 'NarrationCompleted', from, 20_000);
      expect(calls()).toBe(4);
      const { gameState } = await savedGame(table);
      expect(Object.keys(gameState.characters ?? {})).toEqual([user.id]);
    } finally {
      client.close();
    }
  }, 30_000);

  it('discards combat tool state from a refused attempt before retrying', async () => {
    const combat = placed(bootstrapped().state, {
      ent_aria: { x: 7, y: 2 },
      'ent_goblin-minion_1': { x: 8, y: 2 },
      'ent_goblin-minion_2': { x: 13, y: 16 },
    });
    const game = (account: string) => ({
      ...preCombatGame(),
      gameEngine: {
        ...preCombatGame().gameEngine,
        actors: { ent_aria: hero },
      },
      characters: { [account]: hero },
      combatActors: { [account]: 'ent_aria' },
      combatRoom: combat,
    });
    const runOnce = async (adapter: LlmAdapter, label: string) => {
      stack = await Stack.boot(label, { adapter, endpointAllowsMature: true });
      const user = await newUser();
      const table = await seedTable(stack, user, game);
      await db.query(
        'UPDATE sessions SET moderation_verified=true, endpoint_allows_mature=true WHERE id=$1',
        [table],
      );
      try {
        const runner = new ProductionSoloTurnRunner(
          db,
          undefined,
          'strict',
          'unused.ndjson',
          adapter,
          true,
          true,
        );
        const result = await runner.run(
          {
            sessionId: table,
            accountId: user.id,
            actionId: randomUUID(),
            text: 'Move to the entrance.',
            state: game(user.id),
          },
          () => {},
        );
        const state = result.state as {
          combatRoom?: RoomCombatState;
          gameEngine?: unknown;
        };
        return { combatRoom: state.combatRoom, gameEngine: state.gameEngine };
      } finally {
        await stack?.stop();
        stack = undefined;
      }
    };
    const clean = await runOnce(combatMoveRetryDm(false), 'clean-combat-move');
    const retried = await runOnce(
      combatMoveRetryDm(true),
      'refused-combat-move',
    );
    expect(retried).toEqual(clean);
  }, 60_000);

  it('keeps character keys as account ids through a committed start without refusal', async () => {
    const requests: LlmRequest[] = [];
    stack = await Stack.boot('control-character-keys', {
      adapter: authoredEncounterDm(requests, 'encounter-e2-lookouts'),
      endpointAllowsMature: true,
      storyCombatEnabled: true,
    });
    const user = await newUser();
    const table = await seedTable(stack, user, preCombat, {
      id: 'adventure:01-hollow-under-marrowfell',
      sceneId: 'scene-warren-gallery',
    });
    await db.query(
      'UPDATE sessions SET moderation_verified=true, endpoint_allows_mature=true WHERE id=$1',
      [table],
    );
    const client = await Client.open(stack, user, table);
    try {
      const from = client.log.length;
      client.say('I advance toward the lookouts.');
      await client.until((m) => m.type === 'CombatTracker', from, 20_000);
      await client.until((m) => m.type === 'NarrationCompleted', from, 20_000);
      expect(requests).toHaveLength(2);
      const { gameState } = await savedGame(table);
      expect(Object.keys(gameState.characters ?? {})).toEqual([user.id]);
    } finally {
      client.close();
    }
  }, 30_000);

  it('rejects illegal commands with no state change and keeps other accounts out', async () => {
    stack = await Stack.boot('combat-illegal');
    const user = await newUser();
    const intruder = await newUser();
    const table = await seedTable(stack, user, (account) => {
      const b = bootstrapped();
      return {
        ...preCombatGame(),
        characters: { [account]: hero },
        combatActors: { [account]: 'ent_aria' },
        combatRoom: b.state,
      };
    });
    const client = await Client.open(stack, user, table);
    // PresenceChanged is persisted after StateSync; wait for it so the
    // baseline is settled and any later event really came from a command.
    await vi.waitFor(
      async () =>
        expect((await storedTypes(table)).map((e) => e.type)).toContain(
          'PresenceChanged',
        ),
      { timeout: 5000 },
    );
    const baseline = await storedTypes(table);
    const snapshot = JSON.stringify(await savedGame(table));
    for (const payload of [
      { command: 'attack', targetId: 'ent_goblin-minion_1', attackId: 'staff' },
      { command: 'move', destination: { x: 0, y: 0 } },
      { command: 'reaction', reactionId: 'nope', choice: 'take' },
      {
        command: 'cast',
        spellId: 'spell:fireball',
        slotLevel: 3,
        target: { kind: 'self' },
      },
    ]) {
      const reply = await client.command(payload);
      expect(reply).toMatchObject({
        type: 'Error',
        payload: {
          code:
            payload.command === 'reaction'
              ? 'not-your-turn'
              : 'COMMAND_REJECTED',
        },
      });
    }
    expect((await storedTypes(table)).length).toBe(baseline.length);
    expect(JSON.stringify(await savedGame(table))).toBe(snapshot);

    // another user cannot reach the table at all
    await expect(Client.open(stack, intruder, table)).rejects.toBeDefined();
    expect((await storedTypes(table)).length).toBe(baseline.length);
    client.close();
  }, 20_000);
});
