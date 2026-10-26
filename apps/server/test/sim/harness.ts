import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import WebSocket from 'ws';
import { createApp } from '../../src/app.js';
import { createSession } from '../../src/accounts/sessions.js';
import { hashToken } from '../../src/accounts/signup.js';
import { quickBuild, type CharacterInput } from '@game/rules-engine';
import { loadCatalog } from '@game/rules-engine/catalog-node';
import type { LlmAdapter } from '../../src/llm/adapter.js';
import { installGateway } from '../../src/gateway/ws.js';
import { Persistence } from '../../src/persistence/index.js';
import { SeatCharacterRepository } from '../../src/persistence/seatCharacters.js';
import { ProductionSoloTurnRunner } from '../../src/room/productionTurnRunner.js';
import { RoomRegistry } from '../../src/room/registry.js';
import { SessionLease } from '../../src/room/lease.js';
import type { Room } from '../../src/room/Room.js';
import type { InputGate } from '../../src/safety/inputGate.js';

/** Server frame as delivered over the socket. Payloads are untyped JSON; tests assert on shape. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ServerFrame = { seq: number; type: string; payload: any };

export interface LogEvent {
  type: string;
  turnId: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  payload: any;
  seq: number;
}

/** A text that the moderation gate rejects. Used by the moderation scenarios. */
export const BLOCKED_MARKER = 'BLOCKED-SIM';

/** Test gate: rejects any text containing BLOCKED_MARKER, allows everything else. */
export function moderationGate(): InputGate {
  const verdict = (text: string) =>
    text.includes(BLOCKED_MARKER) ? ('block' as const) : ('allow' as const);
  return {
    check: async ({ text }) => verdict(text),
    checkChat: async ({ text }) => ({
      decision: verdict(text),
      attributable: false,
    }),
    logChatRejection: async () => undefined,
    logChatFailure: async () => undefined,
  };
}

export interface SimTableOptions {
  /** Number of seated players; index 0 is the table host. */
  players: number;
  dm: LlmAdapter;
  gate?: InputGate;
  /** Display name prefix; players are named `${prefix}${index + 1}`. */
  namePrefix?: string;
}

/**
 * One table backed by real Postgres, a real Fastify + ws gateway on a loopback port,
 * and the production RoomRegistry. Every player is a seated account with a real session.
 */
export class SimTable {
  readonly clients: SimClient[];
  /** Seated characters, index-aligned with `clients`. Combat scenarios bind these to seats. */
  readonly characters: CharacterInput[] = [];
  private readonly tokens: string[];

  private constructor(
    readonly db: Pool,
    readonly sessionId: string,
    readonly accountIds: string[],
    tokens: string[],
    private readonly app: ReturnType<typeof createApp>,
    private readonly rooms: RoomRegistry,
    readonly base: string,
  ) {
    this.tokens = tokens;
    this.clients = accountIds.map(
      (accountId, index) =>
        new SimClient(this, accountId, tokens[index]!, `Sim ${index + 1}`),
    );
  }

  get wsBase(): string {
    return this.base.replace('http', 'ws');
  }

  get host(): SimClient {
    return this.clients[0]!;
  }

  static async start(db: Pool, options: SimTableOptions): Promise<SimTable> {
    const accountIds = Array.from({ length: options.players }, () =>
      randomUUID(),
    );
    for (const [index, id] of accountIds.entries())
      await db.query(
        `INSERT INTO accounts(id,email,password_hash,display_name,status,is_adult,age_checked_at,terms_version,terms_accepted_at) VALUES($1,$2,'hash',$3,'active',true,now(),'v1',now())`,
        [
          id,
          `${id}@example.test`,
          `${options.namePrefix ?? 'Sim '}${index + 1}`,
        ],
      );
    const sessionId = randomUUID();
    await db.query('INSERT INTO sessions(id,owner_account_id) VALUES($1,$2)', [
      sessionId,
      accountIds[0],
    ]);
    const tokens = await Promise.all(
      accountIds.map((id) => createSession(db, id, 'test')),
    );
    const persistence = new Persistence(db);
    const runner = new ProductionSoloTurnRunner(
      db,
      undefined,
      undefined,
      undefined,
      options.dm,
      false,
    );
    const rooms = new RoomRegistry(
      persistence,
      new SessionLease(db),
      `sim-${randomUUID()}`,
      undefined,
      undefined,
      runner,
    );
    const app = createApp(db, {
      inputGate: options.gate ?? moderationGate(),
    });
    installGateway(app, db, rooms);
    const base = await app.listen({ host: '127.0.0.1', port: 0 });
    const table = new SimTable(
      db,
      sessionId,
      accountIds,
      tokens,
      app,
      rooms,
      base,
    );
    const room = await rooms.get(sessionId);
    const seatCharacters = new SeatCharacterRepository(db);
    const catalog = loadCatalog();
    for (const [index, id] of accountIds.entries()) {
      await room.seat(
        id,
        `${options.namePrefix ?? 'Sim '}${index + 1}`,
        false,
        hashToken(tokens[index]!),
      );
      const character = {
        ...quickBuild(catalog, undefined, index + 1, 1).character,
        id: randomUUID(),
      };
      table.characters.push(character);
      const revision = await seatCharacters.saveOwnedCharacter(id, character);
      await room.bindSeatCharacter(
        id,
        character.id,
        revision,
        async () => true,
      );
    }
    // Same lifecycle step as POST /api/tables: rounds only open once game state exists.
    await room.persistGameState({ premise: 'Sim table', worldSeeded: true });
    return table;
  }

  room(): Promise<Room> {
    return this.rooms.get(this.sessionId);
  }

  /** Event log for this table, oldest first, optionally filtered by type. */
  async events(type?: string): Promise<LogEvent[]> {
    // Read the full log. Persistence.loadLatest only returns rows after the newest snapshot.
    const { rows } = await this.db.query<{
      type: string;
      turn_id: string;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      payload: any;
      seq: number;
    }>(
      'SELECT seq, turn_id, type, payload FROM events WHERE session_id=$1 ORDER BY seq',
      [this.sessionId],
    );
    const mapped = rows.map((row) => ({
      type: row.type,
      turnId: row.turn_id,
      payload: row.payload,
      seq: row.seq,
    }));
    return type ? mapped.filter((event) => event.type === type) : mapped;
  }

  /** Fetch a single-use WS ticket through the real HTTP route. */
  async ticket(
    token: string,
    sessionId: string,
  ): Promise<{ ticket: string; resumeToken?: string } | undefined> {
    const res = await fetch(`${this.base}/api/ws-ticket`, {
      method: 'POST',
      headers: {
        origin: this.base,
        cookie: `sid=${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ sessionId }),
    });
    if (res.status !== 200) return undefined;
    return (await res.json()) as { ticket: string; resumeToken?: string };
  }

  async stop(): Promise<void> {
    for (const client of this.clients) await client.disconnect();
    await this.rooms.drain();
    await this.app.close();
  }

  /** Test hook: token for direct HTTP calls (e.g., revocation checks). */
  tokenFor(index: number): string {
    return this.tokens[index]!;
  }
}

/** One seat's socket. Frames are buffered so tests can await any message type. */
export class SimClient {
  socket?: WebSocket;
  readonly inbox: ServerFrame[] = [];
  closeCode?: number;
  lastSeq = 0;
  private resumeToken?: string;

  constructor(
    private readonly table: SimTable,
    readonly accountId: string,
    private readonly token: string,
    readonly name: string,
  ) {}

  /**
   * Opens a socket via a real WS ticket. Resolves once StateSync arrives, or
   * returns the close code if the gateway refuses the socket first.
   */
  async connect(): Promise<number | undefined> {
    const ticketResult = await this.table.ticket(
      this.token,
      this.table.sessionId,
    );
    if (!ticketResult) return 1008;
    if (ticketResult.resumeToken) this.resumeToken = ticketResult.resumeToken;
    const socket = new WebSocket(
      `${this.table.wsBase}/ws?ticket=${ticketResult.ticket}`,
      {
        origin: this.table.base,
      },
    );
    this.socket = socket;
    this.closeCode = undefined;
    const syncsBefore = this.messages('StateSync').length;
    socket.on('message', (data) => {
      const frame = JSON.parse(data.toString()) as ServerFrame;
      this.lastSeq = Math.max(this.lastSeq, frame.seq ?? 0);
      this.inbox.push(frame);
      if (frame.type === 'SeatResumeChallenge')
        socket.send(
          JSON.stringify({
            type: 'ResumeSeat',
            payload: { resumeToken: this.resumeToken },
          }),
        );
      if (
        frame.type === 'SeatAuthenticated' &&
        typeof frame.payload?.resumeToken === 'string'
      )
        this.resumeToken = frame.payload.resumeToken;
      if (frame.type === 'StateSync')
        socket.send(
          JSON.stringify({
            actionId: randomUUID(),
            type: 'StateSyncAck',
            payload: { seq: frame.seq },
            lastSeq: frame.seq,
          }),
        );
    });
    socket.on('close', (code) => {
      this.closeCode = code;
    });
    await new Promise<void>((resolve) => {
      socket.once('open', () => resolve());
      socket.once('close', () => resolve());
      socket.once('error', () => resolve());
    });
    if (this.closeCode !== undefined) return this.closeCode;
    // Wait for a StateSync from this socket, not one buffered from an earlier connection.
    await this.waitFor(() => this.messages('StateSync').length > syncsBefore);
    return undefined;
  }

  async disconnect(): Promise<void> {
    const socket = this.socket;
    if (!socket || socket.readyState >= WebSocket.CLOSING) return;
    await new Promise<void>((resolve) => {
      socket.once('close', () => resolve());
      socket.close(1000);
    });
  }

  /** Drops the socket and reconnects with a fresh ticket. */
  async reconnect(): Promise<number | undefined> {
    await this.disconnect();
    return this.connect();
  }

  /** Sends a client envelope. Returns the actionId used. */
  send(type: string, payload: Record<string, unknown>): string {
    const actionId = randomUUID();
    this.socket!.send(
      JSON.stringify({ actionId, type, payload, lastSeq: this.lastSeq }),
    );
    return actionId;
  }

  submit(text: string): string {
    return this.send('PlayerAction', { text });
  }

  edit(editedActionId: string, text: string): string {
    return this.send('EditAction', { editedActionId, text });
  }

  withdraw(withdrawnActionId: string): string {
    return this.send('WithdrawAction', { withdrawnActionId });
  }

  chat(text: string): string {
    return this.send('ChatSend', { text });
  }

  configureTimer(durationMs: number | null): string {
    return this.send('ConfigureRoundTimer', { durationMs });
  }

  resolveNow(): string {
    return this.send('ResolveNow', {});
  }

  messages(type: string): ServerFrame[] {
    return this.inbox.filter((frame) => frame.type === type);
  }

  /** Waits for a frame matching the predicate, including frames already buffered. */
  async waitFor(
    predicate: (frame: ServerFrame) => boolean,
    timeoutMs = 5000,
  ): Promise<ServerFrame> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = this.inbox.find(predicate);
      if (found) return found;
      if (Date.now() > deadline)
        throw new Error(`${this.name}: timed out waiting for frame`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  async waitForType(type: string, count = 1, timeoutMs = 5000) {
    await this.waitFor(() => this.messages(type).length >= count, timeoutMs);
    return this.messages(type);
  }
}

/** Polls an async predicate until it holds or the deadline passes. */
export async function eventually(
  check: () => Promise<boolean>,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
