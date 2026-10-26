import type { RoomCombatState } from '../../src/room/combat.js';
import { seatEntityId } from '../../src/room/seatEntity.js';
import { partyCombat, placed } from '../room/combatFixtures.js';
import type { ServerFrame, SimClient, SimTable } from './harness.js';

/** Goblin 1 is the reactor: the mover provokes it by leaving its reach. */
export const GOBLIN = 'ent_goblin-minion_1';
/** Goblin 2 stays far away so only one reaction is ever open. */
export const GOBLIN_FAR = 'ent_goblin-minion_2';
/** Where the mover stands (beside goblin 1) and where it walks to, provoking one reaction. */
const MOVER_START = { x: 7, y: 2 };
const GOBLIN_START = { x: 8, y: 2 };
const LEAVE_TO = { x: 7, y: 6 };

interface CombatCarrier {
  combatRoom: RoomCombatState;
  combatActors?: Record<string, string>;
}

/**
 * Starts real party combat on a live SimTable. The engine bootstraps from the crypt map with the
 * seats' own characters, exactly as a DM start_combat does in production. Seat 0 (the mover) is
 * placed beside goblin 1 and acts first; `controller` seats goblin 1, so its reactions are a
 * human prompt. The state is persisted through the Room, so the WS path and event log are real.
 */
export async function startPartyCombat(
  table: SimTable,
  controller: SimClient,
  seed = 7,
) {
  const room = await table.room();
  const characters = Object.fromEntries(
    table.clients.map((client, index) => [
      client.accountId,
      table.characters[index]!,
    ]),
  );
  const bindings = new Map(
    room.state.seats.map((seat) => {
      const index = table.clients.findIndex(
        (client) => client.accountId === seat.accountId,
      );
      return [
        seat.seatId,
        {
          characterSnapshot: table.characters[index]! as unknown as Record<
            string,
            unknown
          >,
        },
      ] as const;
    }),
  );
  const started = partyCombat(
    seed,
    characters,
    bindings,
  ) as unknown as CombatCarrier;
  const mover = seatEntityId(
    room.state.seats.find(
      (seat) => seat.accountId === table.clients[0]!.accountId,
    )!.seatId,
  );
  const placedState = placed(started.combatRoom, {
    [mover]: MOVER_START,
    [GOBLIN]: GOBLIN_START,
    [GOBLIN_FAR]: { x: 12, y: 16 },
  });
  const initiative = [
    { entityId: mover, total: 99 },
    ...placedState.combat.initiative.filter((item) => item.entityId !== mover),
  ];
  const combatRoom: RoomCombatState = {
    ...placedState,
    combat: { ...placedState.combat, initiative, activeEntityId: mover },
  };
  await room.persistGameState({
    ...(started as object),
    combatRoom,
    combatActors: { [controller.accountId]: GOBLIN },
  });
  return { room, mover, moverClient: table.clients[0]!, leaveTo: LEAVE_TO };
}

/** The server's live tracker for this table: whose turn it is and whether the encounter is still open. */
export async function liveCombat(table: SimTable): Promise<RoomCombatState> {
  const room = await table.room();
  return (room.state.gameState as { combatRoom: RoomCombatState }).combatRoom;
}

const MIN_GAP_MS = 150;
const lastSent = new WeakMap<SimClient, number>();

/**
 * Sends one CombatCommand and resolves with its reply: CombatTracker/CombatOptions, or the Error for
 * this actionId. Mirrors the combat DB test: narration-in-progress waits for NarrationCompleted, and
 * RATE_LIMITED backs off a bounded number of times, so a real limiter regression still fails.
 */
export async function combatCommand(
  client: SimClient,
  payload: Record<string, unknown>,
): Promise<ServerFrame> {
  let rateLimited = 0;
  for (let attempt = 0; attempt < 60; attempt++) {
    const wait = (lastSent.get(client) ?? 0) + MIN_GAP_MS - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    lastSent.set(client, Date.now());
    const mark = client.inbox.length;
    const actionId = client.send('CombatCommand', payload);
    const reply = await pollFrom(
      client,
      mark,
      (frame) =>
        ((frame.type === 'CombatTracker' ||
          frame.type === 'CombatOptions') &&
          frame.payload?.commandActionId === actionId) ||
        (frame.type === 'Error' &&
          (frame.payload?.actionId === actionId ||
            (frame.payload?.code === 'RATE_LIMITED' &&
              frame.payload?.actionId === undefined))),
    );
    if (String(reply.payload?.message ?? '').includes('still narrating')) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      continue;
    }
    if (reply.payload?.code === 'narration-in-progress') {
      await pollFrom(
        client,
        client.inbox.indexOf(reply) + 1,
        (frame) => frame.type === 'NarrationCompleted',
        20_000,
      );
      continue;
    }
    if (reply.payload?.code === 'RATE_LIMITED') {
      if (++rateLimited > 5)
        throw new Error(
          `RATE_LIMITED ${rateLimited} times sending ${JSON.stringify(payload)}`,
        );
      await new Promise((resolve) => setTimeout(resolve, 300));
      continue;
    }
    return reply;
  }
  throw new Error(`DM never finished narrating ${JSON.stringify(payload)}`);
}

/** Waits for a frame at or after `from`, so an older frame of the same type never satisfies the wait. */
export async function pollFrom(
  client: SimClient,
  from: number,
  match: (frame: ServerFrame) => boolean,
  timeoutMs = 8000,
): Promise<ServerFrame> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const hit = client.inbox.slice(from).find(match);
    if (hit) return hit;
    if (Date.now() > deadline)
      throw new Error(
        `${client.name}: timed out; saw ${client.inbox
          .slice(from)
          .map((f) => f.type + (f.payload?.code ? `:${f.payload.code}` : ''))
          .join(',')}`,
      );
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Frames of one type received by this socket since it last connected. */
export function framesOf(client: SimClient, type: string): ServerFrame[] {
  return client.inbox.filter((frame) => frame.type === type);
}
