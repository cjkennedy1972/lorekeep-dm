import { allowInputGate } from '../support/allowInputGate.js';
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
import type { LlmRequest } from '../../src/llm/adapter.js';
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
  static async boot(node: string): Promise<Stack> {
    const requests: LlmRequest[] = [];
    const runner = new ProductionSoloTurnRunner(
      db,
      undefined,
      'strict',
      'unused.ndjson',
      scriptedDm(requests),
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
    const app = createApp(
      db,
      { inputGate: allowInputGate, rooms, connections },
      { inputGate: allowInputGate },
    );
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
  private constructor(readonly ws: WebSocket) {
    ws.on('message', (data) => this.log.push(JSON.parse(data.toString())));
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
    const client = new Client(ws);
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
  async command(payload: Record<string, unknown>, retries = 40): Promise<Wire> {
    for (let attempt = 0; attempt < retries; attempt++) {
      // Stay under the gateway's per-socket message rate limit (10/s sustained).
      const wait = this.lastSent + 100 - Date.now();
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
          (m.type === 'Error' && m.payload?.actionId === actionId),
        mark,
      );
      if (reply.payload?.message?.includes('still narrating')) {
        await new Promise((r) => setTimeout(r, 50));
        continue;
      }
      return reply;
    }
    throw new Error('DM never finished narrating');
  }
  last<T = Record<string, unknown>>(type: string): T {
    return [...this.log].reverse().find((m) => m.type === type)?.payload as T;
  }
  close() {
    this.ws.close();
  }
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
) {
  const table = randomUUID();
  await db.query(
    'INSERT INTO sessions(id,owner_account_id,name) VALUES($1,$2,$3)',
    [table, owner.id, 'Crypt'],
  );
  sessionIds.push(table);
  const room = await s.rooms.get(table);
  await room.seat(owner.id, 'Aria');
  const gameState = game(owner.id);
  await room.persistGameState(gameState);
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
  it('start_combat populates the Room, monsters act, and the fight ends in CombatEnded with an accepted opportunity attack', async () => {
    stack = await Stack.boot('combat-full');
    const user = await newUser();
    const table = await seedTable(stack, user, preCombat);
    await stack.stop();
    stack = await Stack.boot('combat-full-2');
    const client = await Client.open(stack, user, table);

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
    expect(stack.requests.length).toBeGreaterThanOrEqual(2);
    const boot = await savedGame(table);
    expect(boot.gameState.combatActors).toEqual({ [user.id]: 'ent_aria' });
    expect(boot.gameState.combatRoom?.entities).toHaveLength(3);

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
        optionsReply.payload?.message === 'Resolve the pending reaction first.'
      ) {
        const prompt = client.last<Record<string, unknown>>('ReactionPrompt');
        if (!prompt?.reactionId)
          throw new Error('Pending reaction has no websocket prompt.');
        await client.command({
          command: 'reaction',
          reactionId: prompt.reactionId,
          choice: 'take',
        });
        continue;
      }
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
            (m) => m.type === 'ReactionPrompt',
            before,
          );
          expect(prompt.payload).toMatchObject({
            moverId: 'ent_aria',
            defaultChoice: 'decline',
          });
          expect(prompt.payload!.timeoutMs).toBeLessThanOrEqual(15_000);
          await client.command({
            command: 'reaction',
            reactionId: prompt.payload!.reactionId,
            choice: 'take',
          });
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
      const open = client.last<unknown>('ReactionPrompt');
      tracker = client.last<unknown>('CombatTracker');
      if (tracker.activeEntityId === 'ent_aria' && !tracker.ended)
        await client.command({ command: 'end-turn' });
      void open;
    }
    const ended = await client.until((m) => m.type === 'CombatEnded', 0);
    expect(['party-victory', 'party-defeated']).toContain(
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
        'ReactionResolved',
        'CombatEnded',
      ]),
    );
    expect(
      (await storedTypes(table)).find((r) => r.type === 'ReactionResolved')!
        .payload,
    ).toMatchObject({ used: true });
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

  it('kill and restart mid-combat resumes the same turn, movement and pending reaction; the answer is idempotent', async () => {
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
    const prompt = await client.until((m) => m.type === 'ReactionPrompt', mark);
    const before = (await savedGame(table)).gameState.combatRoom!;
    expect(before.pendingReaction).toBeDefined();
    const remaining = before.combat.resources.ent_aria!.movementRemaining;
    client.close();

    // kill -9: the process and its in-memory Room are gone; only Postgres remains
    await stack.stop();
    stack = await Stack.boot('combat-resume-3');
    client = await Client.open(stack, user, table);
    const resumed = await client.until((m) => m.type === 'ReactionPrompt', 0);
    expect(resumed.payload!.reactionId).toBe(prompt.payload!.reactionId);
    const tracker = await client.until((m) => m.type === 'CombatTracker', 0);
    expect(tracker.payload).toMatchObject({ activeEntityId: 'ent_aria' });
    expect(tracker.payload!.resources.ent_aria.movementRemaining).toBe(
      remaining,
    );

    const actionId = randomUUID();
    const answer = JSON.stringify({
      type: 'CombatCommand',
      actionId,
      lastSeq: 0,
      payload: {
        command: 'reaction',
        reactionId: resumed.payload!.reactionId,
        choice: 'take',
      },
    });
    const mark2 = client.log.length;
    client.ws.send(answer);
    await client.until(
      (m) =>
        m.type === 'CombatEvents' &&
        m.payload!.events.some((e: unknown) => e.type === 'ReactionResolved'),
      mark2,
    );
    await client.until((m) => m.type === 'NarrationCompleted', mark2);
    const persistDeadline = Date.now() + 5000;
    while (
      !(await storedTypes(table)).some(
        (event) => event.type === 'NarrationCompleted',
      )
    ) {
      if (Date.now() > persistDeadline)
        throw new Error('Combat narration was not persisted.');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const count = (await storedTypes(table)).length;
    const mark3 = client.log.length;
    client.ws.send(answer);
    await client.until(
      (m) => m.type === 'Error' && m.payload?.code === 'DUPLICATE_ACTION',
      mark3,
    );
    expect((await storedTypes(table)).length).toBe(count);
    expect(
      (await savedGame(table)).gameState.combatRoom!.pendingReaction,
    ).toBeUndefined();
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
        payload: { code: 'COMMAND_REJECTED' },
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
