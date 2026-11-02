import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Room, narrationFacts, type RoomStore } from '../../src/room/Room.js';
import type { CombatRuntime } from '../../src/room/combat.js';
import type { SoloTurnRunner } from '../../src/room/dmTurn.js';
import type { StoredEvent } from '../../src/persistence/index.js';
import { seatEntityId } from '../../src/room/seatEntity.js';

const sessionId = randomUUID();
const lease = {
  sessionId,
  nodeId: 'node',
  epoch: 1,
  expiresAt: new Date(Date.now() + 60_000),
};
const runner = { async run() {} } as unknown as SoloTurnRunner;

function party(
  options: {
    bindA?: boolean;
    bindB?: boolean;
    partyMode?: boolean;
    gameState?: (seatA: string) => unknown;
    round?: (seatA: string, seatB: string) => unknown;
    runtime?: CombatRuntime;
    hostA?: boolean;
    roundsEnabled?: boolean;
    turnRunner?: SoloTurnRunner;
    failBindingReload?: boolean;
  } = {},
) {
  const [accountA, accountB, seatA, seatB] = [1, 2, 3, 4].map(() =>
    randomUUID(),
  );
  const writes: { events: string[]; transition: unknown }[] = [];
  const stored: StoredEvent[] = [];
  const store = {
    async loadLatest() {
      return { snapshot: null, events: [] };
    },
    async loadActiveSeatCharacterBindings() {
      if (options.failBindingReload)
        throw new Error('simulated reload failure');
      return [];
    },
    async writeTurn(
      _id: string,
      inputs: StoredEvent[],
      _state: unknown,
      _lease: unknown,
      _a: unknown,
      _b: unknown,
      _c: unknown,
      _d: unknown,
      transition: unknown,
    ) {
      writes.push({ events: inputs.map((i) => i.type), transition });
      const out = inputs.map((input, index) => ({
        ...input,
        seq: stored.length + index + 1,
        sessionId,
        ts: new Date(),
      })) as StoredEvent[];
      stored.push(...out);
      const bind = (transition ?? {}) as {
        kind?: string;
        seatId?: string;
        accountId?: string;
      };
      return {
        events: out,
        ...(bind.kind === 'bind'
          ? {
              binding: {
                seatId: bind.seatId!,
                accountId: bind.accountId!,
                characterSnapshot: { name: 'Committed sheet' },
              },
            }
          : {}),
      };
    },
    async isTableHost(_id: string, accountId: string) {
      return options.hostA === true && accountId === accountA;
    },
  } as unknown as RoomStore;
  const secret = { name: 'Secret sheet name' };
  const bindings = [
    ...(options.bindA === false
      ? []
      : [{ seatId: seatA, accountId: accountA, characterSnapshot: secret }]),
    ...(options.bindB
      ? [{ seatId: seatB, accountId: accountB, characterSnapshot: secret }]
      : []),
  ];
  const seat = (seatId: string, accountId: string) => ({
    seatId,
    accountId,
    displayName: accountId.slice(0, 4),
    presence: 'connected' as const,
  });
  const room = new Room(
    store,
    lease,
    {
      snapshot: {
        sessionId,
        seq: 0,
        createdAt: new Date(),
        state: {
          sessionId,
          phase: 'lobby',
          ...(options.roundsEnabled ? { roundsEnabled: true } : {}),
          seats: [seat(seatA, accountA), seat(seatB, accountB)],
          gameState: options.gameState?.(seatA) ?? {},
          ...(options.round ? { round: options.round(seatA, seatB) } : {}),
        },
      },
      events: [],
    },
    options.turnRunner ?? runner,
    options.runtime,
    bindings,
    options.partyMode ?? true,
  );
  return { room, writes, stored, accountA, accountB, seatA, seatB };
}

import { createCombatRuntime as crt } from '../../src/room/combat.js';

const probeMap = {
  mapId: 'probe',
  w: 8,
  h: 8,
  palette: [
    {
      terrainId: 'floor',
      moveCost: 1,
      blocksMove: false,
      blocksSight: false,
      cover: 'none',
      elevation: 0,
    },
  ],
  cells: [0, 64],
  edges: [],
  features: [],
  markers: [],
  zones: [],
  diagonalRule: '5ft',
} as never;

async function probeFixture(turnRunner?: SoloTurnRunner) {
  const f = party({ bindB: true, ...(turnRunner ? { turnRunner } : {}) });
  const entA = seatEntityId(f.seatA);
  const entB = seatEntityId(f.seatB);
  f.room.state.gameState = {
    characters: {
      [f.seatA]: { id: entA, name: 'A' },
      [f.seatB]: { id: entB, name: 'B' },
    },
    combatRoom: {
      map: probeMap,
      entities: [
        {
          id: entA,
          kind: 'character',
          team: 'party',
          hp: 9,
          maxHp: 9,
          pos: { x: 1, y: 1 },
          size: 1,
          ac: 15,
          attacks: [
            {
              id: 'sword',
              name: 'Sword',
              attackBonus: 5,
              damage: '1d8+3',
              damageType: 'slashing',
              reachFt: 5,
            },
          ],
        },
        {
          id: entB,
          kind: 'character',
          team: 'party',
          hp: 9,
          maxHp: 9,
          pos: { x: 2, y: 3 },
          size: 1,
          ac: 13,
        },
        {
          id: 'goblin',
          kind: 'monster',
          team: 'foe',
          hp: 7,
          maxHp: 7,
          ac: 10,
          pos: { x: 2, y: 2 },
          size: 1,
        },
        {
          id: 'rogue',
          hidden: true,
          kind: 'monster',
          team: 'foe',
          hp: 11,
          maxHp: 11,
          pos: { x: 7, y: 9 },
          size: 1,
        },
      ],
      combat: {
        round: 1,
        activeEntityId: entA,
        initiative: [entA, 'goblin', 'rogue', entB].map((entityId, i) => ({
          entityId,
          total: 20 - i,
        })),
        resources: {
          [entA]: {
            action: true,
            bonusAction: true,
            reaction: true,
            movementRemaining: 30,
          },
          [entB]: {
            action: true,
            bonusAction: true,
            reaction: true,
            movementRemaining: 30,
          },
          goblin: {
            action: true,
            bonusAction: true,
            reaction: true,
            movementRemaining: 30,
          },
          rogue: {
            action: true,
            bonusAction: true,
            reaction: true,
            movementRemaining: 30,
          },
        },
      },
    },
  };
  return { f, entA, entB };
}

describe('roll projection security', () => {
  it('does not deliver a live attack roll naming a hidden actor to a non-controlling seat', async () => {
    const ids = { entA: '' };
    let turnRuns = 0;
    const turnRunner = {
      async run(_req: unknown, emit: (e: Record<string, unknown>) => void) {
        turnRuns += 1;
        emit({
          type: 'RollEvent',
          entityId: 'rogue',
          kind: 'attack',
          attackId: 'bite',
          targetId: ids.entA,
          hit: true,
          breakdown: {
            expression: '1d20+4',
            dice: [{ sides: 20, value: 15, kept: true }],
            modifiers: [{ label: 'attack', value: 4 }],
            total: 19,
          },
        });
        return undefined as never;
      },
    } as unknown as SoloTurnRunner;
    const { f, entA } = await probeFixture(turnRunner);
    ids.entA = entA;
    // Account A controls the hidden actor; B does not. Keep the event live so
    // this exercises per-viewer projection rather than only hidden-id filtering.
    f.room.state.gameState = {
      ...(f.room.state.gameState as Record<string, unknown>),
      combatActors: { [f.accountA]: 'rogue' },
    };
    const inbox: Record<string, Record<string, unknown>[]> = { a: [], b: [] };
    await f.room.subscribe(f.accountA, {
      send: (m: Record<string, unknown>) => void inbox.a!.push(m),
    });
    await f.room.subscribe(f.accountB, {
      send: (m: Record<string, unknown>) => void inbox.b!.push(m),
    });
    for (const k of ['a', 'b']) inbox[k]!.length = 0;
    await f.room.submitAction(f.accountA, randomUUID(), 'I strike', 'A');
    expect(turnRuns).toBe(1);
    const summarize = (msgs: Record<string, unknown>[]) =>
      msgs.filter((m) => m.type === 'RollEvent').map((m) => m.payload ?? m);
    expect(summarize(inbox.a!)).toHaveLength(1);
    expect(summarize(inbox.a!)[0]).toMatchObject({
      type: 'RollEvent',
      actorId: 'rogue',
      targetId: entA,
      label: 'attack bite',
    });
    expect(summarize(inbox.b!)).toEqual([]);
  });

  it('reveals exact damage rolls to the controlling seat of the targeted PC only', async () => {
    let targetEntityId = '';
    const turnRunner = {
      async run(_req: unknown, emit: (event: Record<string, unknown>) => void) {
        emit({
          type: 'RollEvent',
          entityId: 'goblin',
          targetId: targetEntityId,
          kind: 'damage',
          attackId: 'claw',
          publicDamage: 5,
          breakdown: {
            expression: '1d6+3',
            dice: [{ sides: 6, value: 2, kept: true }],
            modifiers: [{ label: 'damage', value: 3 }],
            total: 5,
          },
        });
        return {
          narration: 'The goblin strikes.',
          events: [],
          state: {},
          turnSeed: '0x0000000000000001',
          usage: { in: 1, out: 1 },
        };
      },
    } as unknown as SoloTurnRunner;
    const { f, entB } = await probeFixture(turnRunner);
    targetEntityId = entB;
    const outsider = randomUUID();
    f.room.state.seats.push({
      seatId: randomUUID(),
      accountId: outsider,
      displayName: 'Outsider',
      presence: 'connected',
    });
    const inbox = new Map<string, Record<string, unknown>[]>([
      [f.accountA, []],
      [f.accountB, []],
      [outsider, []],
    ]);
    for (const account of inbox.keys())
      await f.room.subscribe(account, {
        send: (message: Record<string, unknown>) =>
          inbox.get(account)!.push(message),
      });
    for (const messages of inbox.values()) messages.length = 0;

    await f.room.submitAction(f.accountA, randomUUID(), 'Hold position', 'A');

    const rolls = (account: string) =>
      inbox.get(account)!.filter((message) => message.type === 'RollEvent');
    expect(rolls(f.accountA)[0]?.payload).not.toHaveProperty('total');
    expect(rolls(f.accountA)[0]?.payload).toHaveProperty('damage', 5);
    expect(rolls(f.accountB)[0]?.payload).toHaveProperty('total', 5);
    expect(rolls(outsider)[0]?.payload).not.toHaveProperty('total');
    expect(rolls(outsider)[0]?.payload).not.toHaveProperty('rolls');
    expect(rolls(outsider)[0]?.payload).not.toHaveProperty('modifier');
  });

  it('reveals committed damage rolls only to the controlling seat of the targeted PC', async () => {
    const { f, entB } = await probeFixture();
    const outsider = randomUUID();
    f.room.state.seats.push({
      seatId: randomUUID(),
      accountId: outsider,
      displayName: 'Outsider',
      presence: 'connected',
    });
    const inbox = new Map<string, Record<string, unknown>[]>([
      [f.accountA, []],
      [f.accountB, []],
      [outsider, []],
    ]);
    for (const account of inbox.keys())
      await f.room.subscribe(account, {
        send: (message: Record<string, unknown>) =>
          inbox.get(account)!.push(message),
      });
    for (const messages of inbox.values()) messages.length = 0;

    const state = (
      f.room.state.gameState as { combatRoom: Record<string, unknown> }
    ).combatRoom;
    (
      f.room as unknown as { announceCombat(...args: unknown[]): void }
    ).announceCombat(
      state,
      [
        {
          type: 'RollEvent',
          entityId: 'goblin',
          targetId: entB,
          kind: 'damage',
          attackId: 'claw',
          breakdown: {
            expression: '1d6+3',
            dice: [{ sides: 6, value: 2, kept: true }],
            modifiers: [{ label: 'damage', value: 3 }],
            total: 5,
          },
        },
      ],
      f.accountA,
    );

    const committedDamageRoll = (account: string) =>
      inbox
        .get(account)!
        .filter((message) => message.type === 'CombatEvents')
        .flatMap(
          (message) =>
            (message.payload as { events: Record<string, unknown>[] }).events,
        )
        .find((event) => event.type === 'RollEvent');
    expect(committedDamageRoll(f.accountB)).toMatchObject({
      total: 5,
      rolls: [2],
      modifier: 3,
    });
    for (const account of [f.accountA, outsider]) {
      expect(committedDamageRoll(account)).not.toHaveProperty('damage');
      expect(committedDamageRoll(account)).not.toHaveProperty('total');
      expect(committedDamageRoll(account)).not.toHaveProperty('rolls');
      expect(committedDamageRoll(account)).not.toHaveProperty('modifier');
    }
  });

  it('projects a committed attack against a visible monster without damage roll details', async () => {
    const { f, entA, entB } = await probeFixture();
    const inbox: Record<string, Record<string, unknown>[]> = { a: [], b: [] };
    await f.room.subscribe(f.accountA, {
      send: (m: Record<string, unknown>) => void inbox.a!.push(m),
    });
    await f.room.subscribe(f.accountB, {
      send: (m: Record<string, unknown>) => void inbox.b!.push(m),
    });
    const state = (
      f.room.state.gameState as { combatRoom: Record<string, unknown> }
    ).combatRoom;
    const runtime = crt();
    let picked:
      | {
          res: Extract<
            ReturnType<CombatRuntime['execute']>,
            { state: unknown }
          >;
          seed: number;
        }
      | undefined;
    for (let seed = 1; seed <= 60 && !picked; seed++) {
      const res = runtime.execute({ ...state, seed } as never, entA, {
        command: 'attack',
        targetId: 'goblin',
        attackId: 'sword',
      } as never);
      if ('code' in res) throw new Error('rejected ' + JSON.stringify(res));
      const hp = res.events.find(
        (e) => e.type === 'HpChanged' && e.entityId === 'goblin',
      );
      if (hp && typeof hp.damage === 'number' && hp.damage > 0)
        picked = { res, seed };
    }
    if (!picked) throw new Error('no damaging seed');
    for (const k of ['a', 'b']) inbox[k]!.length = 0;
    (
      f.room as unknown as { announceCombat(...a: unknown[]): void }
    ).announceCombat(
      {
        ...state,
        entities: picked.res.state.entities,
        combat: picked.res.state.combat,
        seed: undefined,
      } as never,
      picked.res.events,
      f.accountA,
    );
    const pick = (msgs: Record<string, unknown>[]) =>
      msgs
        .filter((m) => m.type === 'CombatEvents')
        .flatMap((m) => {
          const payload = m.payload as { events: Record<string, unknown>[] };
          return payload.events;
        });
    const other = pick(inbox.b!);
    const damageRoll = other.find(
      (e) => e.type === 'RollEvent' && e.label === 'damage',
    );
    expect(damageRoll).toBeDefined();
    expect(damageRoll).not.toHaveProperty('damage');
    expect(damageRoll).not.toHaveProperty('total');
    expect(damageRoll).not.toHaveProperty('rolls');
    expect(damageRoll).not.toHaveProperty('modifier');
    expect(other.find((e) => e.type === 'HpChanged')).toMatchObject({
      type: 'HpChanged',
      entityId: 'goblin',
      hpState: 'wounded',
    });
    expect(entB).toBeTruthy();
  });

  it('omits summarized damage for monsters but retains it for party characters', () => {
    const attacks = (targetId: string) =>
      Array.from({ length: 9 }, (_, index) => [
        {
          type: 'RollEvent',
          kind: 'attack',
          entityId: 'attacker',
          targetId,
          hit: true,
        },
        { type: 'HpChanged', entityId: targetId, damage: index + 1 },
      ]).flat();

    const monster = narrationFacts(attacks('goblin'), new Set(['attacker']));
    const pc = narrationFacts(
      attacks('party-pc'),
      new Set(['attacker', 'party-pc']),
    );

    expect(monster).toContainEqual(
      expect.objectContaining({
        type: 'AttackSummary',
        actorId: 'attacker',
        targetId: 'goblin',
        attacks: 9,
        hits: 9,
      }),
    );
    expect(
      monster.find((fact) => fact.type === 'AttackSummary'),
    ).not.toHaveProperty('damage');
    expect(pc).toContainEqual(
      expect.objectContaining({
        type: 'AttackSummary',
        actorId: 'attacker',
        targetId: 'party-pc',
        attacks: 9,
        hits: 9,
        damage: 45,
      }),
    );
  });
});
