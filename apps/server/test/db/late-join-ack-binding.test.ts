// Late-join admission, snapshot acknowledgement, and character-binding lifecycle on real Postgres.
import { createHash, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { quickBuild } from '@game/rules-engine';
import { loadCatalog } from '@game/rules-engine/catalog-node';
import { Room, type Connection } from '../../src/room/Room.js';
import { Persistence } from '../../src/persistence/index.js';
import {
  characterRulesInput,
  SeatCharacterRepository,
} from '../../src/persistence/seatCharacters.js';
import type { SoloTurnRunner } from '../../src/room/dmTurn.js';
import { rleEncode, type Battlemap } from '@game/schema';

const map: Battlemap = {
  mapId: 'scene-map',
  w: 3,
  h: 2,
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
  cells: rleEncode(Array(6).fill(0)),
  edges: [],
  features: [],
  markers: [{ markerId: 'party-entry', cell: { x: 0, y: 0 }, label: 'Entry' }],
  zones: [
    {
      zoneId: 'player-entry',
      kind: 'spawn',
      cells: [
        { x: 1, y: 0 },
        { x: 2, y: 0 },
      ],
    },
  ],
  diagonalRule: '5ft',
} as Battlemap;
const setScene = (room: Room) =>
  room.persistGameState({
    sceneId: 'scene-1',
    gameEngine: { map, entities: [] },
  });

const db = new Pool({ connectionString: process.env.DATABASE_URL, max: 10 });
afterAll(async () => db.end());
const catalog = loadCatalog();
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}
const store = new Persistence(db);
const repo = new SeatCharacterRepository(db);

const runner: SoloTurnRunner = {
  async run(request) {
    const close = /close/.test(request.text);
    return {
      narration: `ok ${request.text}`,
      events: [
        { type: 'TurnStarted', turnId: request.actionId },
        ...(close
          ? [
              {
                type: 'SceneClosed',
                sceneId: `scene-${request.actionId}`,
                summary: 'Done.',
              },
            ]
          : []),
      ],
      state: request.state as Record<string, unknown>,
      turnSeed: '0x0000000000000001',
      usage: { in: 1, out: 1 },
    } as never;
  },
};

async function account() {
  const id = randomUUID();
  await db.query(
    `INSERT INTO accounts(id,email,password_hash,display_name,status,is_adult,age_checked_at,terms_version,terms_accepted_at)
     VALUES($1,$2,'x','Late Join Test','active',true,now(),'v1',now())`,
    [id, `${id}@example.test`],
  );
  return id;
}
async function character(accountId: string, seed: number) {
  const character = {
    ...quickBuild(catalog, undefined, seed, 1).character,
    id: randomUUID(),
  };
  const revision = await repo.saveOwnedCharacter(accountId, character);
  return { character, revision };
}
async function solo() {
  const owner = await account();
  const ownerChar = await character(owner, 0x41);
  const sessionId = randomUUID();
  await db.query(
    "INSERT INTO sessions(id,owner_account_id,name,status,mode,character_id,character) VALUES($1,$2,'Late Join Test','active','solo',$3,$4::jsonb)",
    [sessionId, owner, ownerChar.character.id, ownerChar.character],
  );
  const lease = {
    sessionId,
    nodeId: 'late-join-test',
    epoch: 1,
    expiresAt: new Date(Date.now() + 600_000),
  };
  await db.query(
    'INSERT INTO session_lease(session_id,node_id,epoch,expires_at) VALUES($1,$2,$3,$4)',
    [sessionId, lease.nodeId, lease.epoch, lease.expiresAt],
  );
  return { owner, ownerChar, sessionId, lease };
}
async function open(f: {
  sessionId: string;
  lease: { sessionId: string; nodeId: string; epoch: number; expiresAt: Date };
}) {
  const latest = await store.loadLatest(f.sessionId);
  const mode = await store.loadSessionMode(f.sessionId);
  const bindings = await store.loadActiveSeatCharacterBindings(f.sessionId);
  return new Room(
    store,
    f.lease,
    latest,
    runner,
    undefined,
    bindings,
    mode === 'party',
  );
}
const rows = async (sid: string) =>
  (
    await db.query<{
      seq: string;
      type: string;
      payload: Record<string, unknown>;
    }>(
      'SELECT seq::text,type,payload FROM events WHERE session_id=$1 ORDER BY events.seq',
      [sid],
    )
  ).rows;
const modeOf = async (sid: string) =>
  (
    await db.query<{ mode: string }>('SELECT mode FROM sessions WHERE id=$1', [
      sid,
    ])
  ).rows[0]!.mode;
const conn = () => {
  const msgs: unknown[] = [];
  return {
    msgs,
    send: (m: unknown) => msgs.push(m),
    close: () => undefined,
  } as Connection & { msgs: unknown[] };
};
async function waitFor(pred: () => boolean | Promise<boolean>, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await pred()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return pred();
}

describe('late-join snapshot acknowledgement and binding', () => {
  it('admits an acknowledged mapless story joiner at the next committed scene boundary', async () => {
    const f = await solo();
    const room = await open(f);
    await room.seat(f.owner, 'Owner');
    await room.persistGameState({ sceneId: 'story-without-map' });

    const joiner = await account();
    const jc = await character(joiner, 0x5a);
    const req = await room.requestLateJoin(
      joiner,
      jc.character.id,
      jc.revision,
      randomUUID(),
      'Joiner',
    );
    await room.approveLateJoin(f.owner, randomUUID(), req);
    expect(room.state.seats.some((seat) => seat.accountId === joiner)).toBe(
      false,
    );

    await room.submitAction(f.owner, randomUUID(), 'close the story scene');
    expect(
      await waitFor(() =>
        room.state.seats.some((seat) => seat.accountId === joiner),
      ),
    ).toBe(true);
    const seat = room.state.seats.find(
      (candidate) => candidate.accountId === joiner,
    )!;
    expect(room.seatCharacters.has(seat.seatId)).toBe(false);
    await expect(
      room.submitAction(joiner, randomUUID(), 'act before snapshot ack'),
    ).rejects.toThrow();

    const connection = conn();
    await room.subscribe(joiner, connection, -1);
    const sync = connection.msgs.find(
      (message) => (message as { type?: string }).type === 'StateSync',
    ) as { seq: number } | undefined;
    expect(sync).toBeDefined();
    await room.acknowledgeLateJoinSnapshot(joiner, seat.seatId, sync!.seq - 1);
    await (
      room as unknown as { admitApprovedLateJoins(): Promise<void> }
    ).admitApprovedLateJoins();
    expect(
      (await rows(f.sessionId)).some(
        (event) => event.type === 'LateJoinAdmitted',
      ),
    ).toBe(false);
    await room.acknowledgeLateJoinSnapshot(joiner, seat.seatId, sync!.seq);
    expect(room.seatCharacters.has(seat.seatId)).toBe(false);

    await room.submitAction(
      f.owner,
      randomUUID(),
      'close the next story scene',
    );
    expect(
      await waitFor(async () =>
        (await rows(f.sessionId)).some(
          (event) => event.type === 'LateJoinAdmitted',
        ),
      ),
    ).toBe(true);
    const ev = await rows(f.sessionId);
    const types = ev.map((event) => event.type);
    expect(types).toContain('SeatCharacterBound');
    expect(types).toContain('LateJoinAdmitted');
    expect(types).not.toContain('LateJoinSpawned');
    expect(types.indexOf('SeatCharacterBound')).toBeLessThan(
      types.indexOf('LateJoinAdmitted'),
    );
    expect(
      (await store.loadActiveSeatCharacterBindings(f.sessionId)).some(
        (binding) => binding.accountId === joiner,
      ),
    ).toBe(true);
    await expect(
      room.submitAction(joiner, randomUUID(), 'act after admission', 'Joiner'),
    ).resolves.toBe(true);
    await room.drain();
  }, 60_000);
  it.each(['leave', 'kick', 'cancel', 'deny'] as const)(
    'atomically terminates an acknowledged joiner before a later story boundary when they %s',
    async (departure) => {
      const f = await solo();
      const room = await open(f);
      await room.seat(f.owner, 'Owner');
      await room.persistGameState({ sceneId: 'story-without-map' });
      const joiner = await account();
      const jc = await character(joiner, 0x5b);
      const req = await room.requestLateJoin(
        joiner,
        jc.character.id,
        jc.revision,
        randomUUID(),
        'Joiner',
      );
      await room.approveLateJoin(f.owner, randomUUID(), req);
      await room.submitAction(
        f.owner,
        randomUUID(),
        'close the first story scene',
      );
      expect(
        await waitFor(() =>
          room.state.seats.some((seat) => seat.accountId === joiner),
        ),
      ).toBe(true);
      expect(
        await waitFor(() =>
          room.state.seats.some((candidate) => candidate.accountId === joiner),
        ),
      ).toBe(true);
      const seat = room.state.seats.find(
        (candidate) => candidate.accountId === joiner,
      )!;
      const connection = conn();
      await room.subscribe(joiner, connection, -1);
      const sync = connection.msgs.find(
        (message) => (message as { type?: string }).type === 'StateSync',
      ) as { seq: number } | undefined;
      expect(sync).toBeDefined();
      await room.acknowledgeLateJoinSnapshot(joiner, seat.seatId, sync!.seq);

      if (departure === 'leave') await room.leave(joiner);
      else if (departure === 'kick')
        await room.kickSeat(f.owner, randomUUID(), seat.seatId);
      else if (departure === 'cancel')
        await room.cancelLateJoin(joiner, randomUUID(), req);
      else await room.denyLateJoin(f.owner, randomUUID(), req);
      await room.submitAction(
        f.owner,
        randomUUID(),
        'close the next story scene',
      );
      const ev = await rows(f.sessionId);
      const terminalType =
        departure === 'deny' ? 'LateJoinDenied' : 'LateJoinCancelled';
      expect(
        ev.some(
          (event) =>
            event.type === terminalType && event.payload.requestId === req,
        ),
      ).toBe(true);
      expect(
        ev.some(
          (event) =>
            event.type === 'LateJoinAdmitted' &&
            event.payload.requestId === req,
        ),
      ).toBe(false);
      expect(
        room.state.seats.some((candidate) => candidate.accountId === joiner),
      ).toBe(false);
      const replayed = await open(f);
      expect(
        replayed.state.lateJoinRequests?.some(
          (request) => request.requestId === req,
        ),
      ).toBe(false);
      const cancellation = ev.find(
        (event) =>
          event.type === terminalType && event.payload.requestId === req,
      )!;
      const revocation = ev.find(
        (event) =>
          event.type === 'SeatRevoked' && event.payload.accountId === joiner,
      )!;
      expect(cancellation.turnId).toBe(revocation.turnId);
      await (
        replayed as unknown as {
          admitApprovedLateJoinsPending(): Promise<void>;
        }
      ).admitApprovedLateJoinsPending();
      const afterRestart = await rows(f.sessionId);
      expect(
        afterRestart.filter(
          (event) =>
            event.type === 'SeatJoined' && event.payload.accountId === joiner,
        ),
      ).toHaveLength(1);
      await room.drain();
      await replayed.drain();
    },
  );

  it.each([false, true])(
    'approves, acknowledges, binds, spawns, and enables an approved joiner (source edited: %s)',
    async (editSource) => {
      const f = await solo();
      let squatter: string | undefined;
      if (editSource) {
        await repo.saveOwnedCharacter(
          f.owner,
          { ...f.ownerChar.character, name: 'Edited after session start' },
          f.ownerChar.revision,
        );
        // Simulate a legacy ID squat after the immutable session snapshot was
        // created. Conversion must bind the snapshot, not this account row.
        squatter = await account();
        await db.query('DELETE FROM account_characters WHERE id=$1', [
          f.ownerChar.character.id,
        ]);
        await db.query(
          'INSERT INTO account_characters(id,account_id,character) VALUES($1,$2,$3::jsonb)',
          [f.ownerChar.character.id, squatter, f.ownerChar.character],
        );
      }
      const room = await open(f);
      await room.seat(f.owner, 'Owner');
      await setScene(room);
      await room.submitAction(f.owner, randomUUID(), 'look around', 'Owner');
      expect(await modeOf(f.sessionId)).toBe('solo');

      const joiner = await account();
      const jc = await character(joiner, 0x52);
      const req = await room.requestLateJoin(
        joiner,
        jc.character.id,
        jc.revision,
        randomUUID(),
        'Joiner',
      );
      expect(room.state.seats.some((s) => s.accountId === joiner)).toBe(false);

      await room.approveLateJoin(f.owner, randomUUID(), req);
      expect(room.state.seats.some((s) => s.accountId === joiner)).toBe(false);
      await room.submitAction(
        f.owner,
        randomUUID(),
        'close the scene',
        'Owner',
      );
      expect(
        await waitFor(() =>
          room.state.seats.some((s) => s.accountId === joiner),
        ),
      ).toBe(true);

      expect(await modeOf(f.sessionId)).toBe('solo');
      const joinerSeat = room.state.seats.find((s) => s.accountId === joiner)!;
      expect(
        (await store.loadActiveSeatCharacterBindings(f.sessionId)).some(
          (binding) => binding.accountId === joiner,
        ),
      ).toBe(false);
      await expect(
        room.submitAction(
          joiner,
          randomUUID(),
          'before snapshot ack',
          'Joiner',
        ),
      ).rejects.toThrow();

      // ADR-035 §3/§4: admission/conversion precedes snapshot ACK, but binding
      // and playable control wait for the authorized seat's ACK.
      const joinerConn = conn();
      await room.subscribe(joiner, joinerConn, -1);
      const sync = joinerConn.msgs.find(
        (message) => (message as { type?: string }).type === 'StateSync',
      ) as { seq: number } | undefined;
      expect(sync).toBeDefined();
      await room.acknowledgeLateJoinSnapshot(
        joiner,
        joinerSeat.seatId,
        sync!.seq,
      );
      await room.submitAction(
        f.owner,
        randomUUID(),
        'close the scene again',
        'Owner',
      );
      expect(
        await waitFor(async () =>
          (await rows(f.sessionId)).some(
            (event) => event.type === 'LateJoinAdmitted',
          ),
        ),
      ).toBe(true);
      expect(await modeOf(f.sessionId)).toBe('party');

      const ev = await rows(f.sessionId);
      const types = ev.map((e) => e.type);
      expect(types).toContain('LateJoinApproved');
      expect(types).toContain('SeatJoined');
      expect(types).toContain('SeatCharacterBound');
      expect(types).toContain('LateJoinSpawned');
      expect(types).toContain('LateJoinAdmitted');
      const bindings = await store.loadActiveSeatCharacterBindings(f.sessionId);
      const bound = bindings.map((b) => b.accountId).sort();
      expect(bound).toContain(joiner);
      expect(bound).toContain(f.owner);
      const ownerBinding = bindings.find(
        (binding) => binding.accountId === f.owner,
      )!;
      const ownerBindingRow = (
        await db.query<{
          character_id: string;
          character_revision: number | null;
          character_snapshot_hash: string | null;
          character_snapshot: Record<string, unknown>;
        }>(
          `SELECT character_id,character_revision,character_snapshot_hash,character_snapshot
           FROM session_seat_characters WHERE session_id=$1 AND seat_id=$2 AND binding_status='active'`,
          [f.sessionId, ownerBinding.seatId],
        )
      ).rows[0]!;
      expect(ownerBindingRow.character_id).not.toBe(f.ownerChar.character.id);
      expect(ownerBindingRow.character_revision).toBeNull();
      expect(ownerBindingRow.character_snapshot_hash).toBe(
        createHash('sha256')
          .update(stableJson(ownerBinding.characterSnapshot))
          .digest('hex'),
      );
      expect(ownerBindingRow.character_snapshot).toEqual(
        ownerBinding.characterSnapshot,
      );
      expect(ownerBinding.characterSnapshot).toEqual({
        ...characterRulesInput(f.ownerChar.character),
        id: ownerBindingRow.character_id,
      });
      if (squatter)
        await db.query('DELETE FROM accounts WHERE id=$1', [squatter]);
      const spawn = ev.find((event) => event.type === 'LateJoinSpawned')!;
      const spawnedEntityId = (spawn.payload as { entityId: string }).entityId;
      const gameState = room.state.gameState as
        | {
            gameEngine?: {
              entities?: Array<{ id: string; hp?: number; maxHp?: number }>;
            };
          }
        | undefined;
      const spawnedEntity = gameState?.gameEngine?.entities?.find(
        (entity) => entity.id === spawnedEntityId,
      );
      expect(spawnedEntity).toBeDefined();
      expect(spawnedEntity!.hp).toBeGreaterThan(0);
      expect(spawnedEntity!.hp).toBe(spawnedEntity!.maxHp);

      // Post-conversion: owner acts, joiner acts.
      await expect(
        room.submitAction(f.owner, randomUUID(), 'owner post-convert', 'Owner'),
      ).resolves.toBeDefined();
      await expect(
        room.submitAction(joiner, randomUUID(), 'joiner act', 'Joiner'),
      ).resolves.toBeDefined();
      const postAdmissionEvents = (await rows(f.sessionId)).map(
        (event) => event.type,
      );
      expect(
        postAdmissionEvents.some(
          (type) => type === 'ActionAccepted' || type === 'RoundActionAccepted',
        ),
      ).toBe(true);

      // Concurrent writes: 4 actions at once.
      const results = await Promise.allSettled([
        room.submitAction(f.owner, randomUUID(), 'concurrent owner a', 'Owner'),
        room.submitAction(
          joiner,
          randomUUID(),
          'concurrent joiner b',
          'Joiner',
        ),
        room.submitAction(f.owner, randomUUID(), 'concurrent owner c', 'Owner'),
        room.submitAction(
          joiner,
          randomUUID(),
          'concurrent joiner d',
          'Joiner',
        ),
      ]);
      expect(results.every((result) => result.status === 'fulfilled')).toBe(
        true,
      );
      const seqs = (await rows(f.sessionId))
        .map((e) => Number(e.seq))
        .sort((a, b) => a - b);
      const unique = new Set(seqs);
      expect(unique.size).toBe(seqs.length);
      for (let i = 1; i < seqs.length; i++)
        expect(seqs[i]!).toBeGreaterThan(seqs[i - 1]!);

      // ADR-035 §5: joiner must not receive owner's private sheet / binding material.
      const joinerJson = JSON.stringify(joinerConn.msgs);
      const leaks = {
        ownerCharacterId: joinerJson.includes(f.ownerChar.character.id),
        ownerPrivateBindingMsg: joinerConn.msgs.some(
          (m) =>
            (m as { type?: string }).type === 'SeatCharacterBoundPrivate' &&
            JSON.stringify(m).includes(
              room.state.seats.find((s) => s.accountId === f.owner)!.seatId,
            ),
        ),
        characterSnapshotKey: joinerJson.includes('characterSnapshot'),
        ownerAbilitiesObject: joinerJson.includes(
          JSON.stringify(f.ownerChar.character.abilities),
        ),
      };
      expect(Object.values(leaks).some(Boolean)).toBe(false);
      await room.drain();
      const restarted = await open(f);
      const persistedOwnerBinding = (
        await store.loadActiveSeatCharacterBindings(f.sessionId)
      ).find((binding) => binding.accountId === f.owner)!;
      expect(persistedOwnerBinding.characterSnapshot).toEqual({
        ...characterRulesInput(f.ownerChar.character),
        id: ownerBindingRow.character_id,
      });
      await restarted.drain();
    },
    60_000,
  );

  it.each([
    ['before commit', false, false],
    ['after commit', true, false],
    ['after commit when reconciliation reads fail', true, true],
  ] as const)(
    'keeps room enforcement consistent after an ambiguous conversion failure %s',
    async (_label, commitBeforeThrow, failReconciliation) => {
      const f = await solo();
      const room = await open(f);
      await room.seat(f.owner, 'Owner');
      await room.persistGameState({ sceneId: 'ambiguous-conversion' });
      const joiner = await account();
      const jc = await character(joiner, 0x63);
      const req = await room.requestLateJoin(
        joiner,
        jc.character.id,
        jc.revision,
        randomUUID(),
        'Joiner',
      );
      await room.approveLateJoin(f.owner, randomUUID(), req);
      await room.submitAction(
        f.owner,
        randomUUID(),
        'close the scene',
        'Owner',
      );
      expect(
        await waitFor(() =>
          room.state.seats.some((candidate) => candidate.accountId === joiner),
        ),
      ).toBe(true);
      const seat = room.state.seats.find(
        (candidate) => candidate.accountId === joiner,
      )!;
      const connection = conn();
      await room.subscribe(joiner, connection, -1);
      const sync = connection.msgs.find(
        (message) => (message as { type?: string }).type === 'StateSync',
      ) as { seq: number };
      await room.acknowledgeLateJoinSnapshot(joiner, seat.seatId, sync.seq);

      const originalWriteTurn = store.writeTurn.bind(store);
      const originalLoadMode = store.loadSessionMode.bind(store);
      const originalLoadBindings =
        store.loadActiveSeatCharacterBindings.bind(store);
      store.writeTurn = async (...args) => {
        const isConversionBind =
          args[8]?.kind === 'bind' && args[9] === 'solo-to-party';
        if (!isConversionBind) return originalWriteTurn(...args);
        if (commitBeforeThrow) await originalWriteTurn(...args);
        throw new Error('injected ambiguous conversion failure');
      };
      if (failReconciliation) {
        let failReads = true;
        store.loadSessionMode = async (sessionId) => {
          if (failReads) {
            failReads = false;
            throw new Error('injected reconciliation read failure');
          }
          return originalLoadMode(sessionId);
        };
        store.loadActiveSeatCharacterBindings = async (sessionId) => {
          if (failReads) {
            failReads = false;
            throw new Error('injected reconciliation read failure');
          }
          return originalLoadBindings(sessionId);
        };
      }
      try {
        await (
          room as unknown as { admitApprovedLateJoins(): Promise<void> }
        ).admitApprovedLateJoins();
      } finally {
        store.writeTurn = originalWriteTurn;
        store.loadSessionMode = originalLoadMode;
        store.loadActiveSeatCharacterBindings = originalLoadBindings;
      }

      const bindings = await originalLoadBindings(f.sessionId);
      const enforced = (room as unknown as { bindingEnforced: boolean })
        .bindingEnforced;
      if (!commitBeforeThrow) {
        expect(await modeOf(f.sessionId)).toBe('solo');
        expect(enforced).toBe(false);
        expect(
          room.state.seats.some((candidate) => candidate.accountId === joiner),
        ).toBe(false);
      } else {
        expect(await modeOf(f.sessionId)).toBe('party');
        expect(bindings.some((binding) => binding.accountId === f.owner)).toBe(
          true,
        );
        expect(bindings.some((binding) => binding.accountId === joiner)).toBe(
          true,
        );
        if (failReconciliation) {
          expect(enforced).toBe(false);
          expect(
            (room as unknown as { soloPartyConversionPending: boolean })
              .soloPartyConversionPending,
          ).toBe(true);
          expect(room.seatCharacters.has(seat.seatId)).toBe(false);
        } else {
          expect(enforced).toBe(true);
          expect(room.seatCharacters.has(seat.seatId)).toBe(true);
        }
        expect(
          room.state.seats.some(
            (candidate) =>
              candidate.accountId === joiner &&
              candidate.presence !== 'revoked',
          ),
        ).toBe(true);
      }
      await room.drain();
    },
  );

  it.each([
    ['transaction rolled back', false],
    ['transaction committed but was unread', true],
  ] as const)(
    'retries solo conversion after ambiguous outcome and failed reconciliation: %s',
    async (_label, commitBeforeThrow) => {
      const f = await solo();
      const room = await open(f);
      await room.seat(f.owner, 'Owner');
      await room.persistGameState({ sceneId: 'conversion-retry' });
      const joiner = await account();
      const jc = await character(joiner, 0x64);
      const req = await room.requestLateJoin(
        joiner,
        jc.character.id,
        jc.revision,
        randomUUID(),
        'Joiner',
      );
      await room.approveLateJoin(f.owner, randomUUID(), req);
      await room.submitAction(
        f.owner,
        randomUUID(),
        'close the scene',
        'Owner',
      );
      expect(
        await waitFor(() =>
          room.state.seats.some((candidate) => candidate.accountId === joiner),
        ),
      ).toBe(true);
      const seat = room.state.seats.find(
        (candidate) => candidate.accountId === joiner,
      )!;
      const connection = conn();
      await room.subscribe(joiner, connection, -1);
      const sync = connection.msgs.find(
        (message) => (message as { type?: string }).type === 'StateSync',
      ) as { seq: number };
      await room.acknowledgeLateJoinSnapshot(joiner, seat.seatId, sync.seq);

      const originalWriteTurn = store.writeTurn.bind(store);
      const originalLoadMode = store.loadSessionMode.bind(store);
      const originalLoadBindings =
        store.loadActiveSeatCharacterBindings.bind(store);
      let failConversionOnce = true;
      let failedReads = 0;
      store.writeTurn = async (...args) => {
        const conversionBind =
          args[8]?.kind === 'bind' && args[9] === 'solo-to-party';
        if (!conversionBind || !failConversionOnce)
          return originalWriteTurn(...args);
        failConversionOnce = false;
        if (commitBeforeThrow) await originalWriteTurn(...args);
        throw new Error('injected ambiguous conversion failure');
      };
      store.loadSessionMode = async (sessionId) => {
        if (failedReads < 2) {
          failedReads++;
          throw new Error('injected reconciliation read failure');
        }
        return originalLoadMode(sessionId);
      };
      store.loadActiveSeatCharacterBindings = async (sessionId) => {
        if (failedReads < 2) {
          failedReads++;
          throw new Error('injected reconciliation read failure');
        }
        return originalLoadBindings(sessionId);
      };

      const admit = (
        room as unknown as {
          admitApprovedLateJoins(): Promise<void>;
        }
      ).admitApprovedLateJoins.bind(room);
      try {
        await admit();
        expect(
          (room as unknown as { bindingEnforced: boolean }).bindingEnforced,
        ).toBe(false);
        expect(
          (room as unknown as { soloPartyConversionPending: boolean })
            .soloPartyConversionPending,
        ).toBe(true);
        expect(
          room.state.seats.some(
            (candidate) =>
              candidate.seatId === seat.seatId &&
              candidate.presence !== 'revoked',
          ),
        ).toBe(true);
        expect(
          connection.msgs.some(
            (message) =>
              (message as { payload?: { code?: string } }).payload?.code ===
              'LATE_JOIN_ADMISSION_RETRY',
          ),
        ).toBe(true);

        await admit();
        expect(await modeOf(f.sessionId)).toBe('party');
        expect(
          (room as unknown as { bindingEnforced: boolean }).bindingEnforced,
        ).toBe(true);
        expect(room.seatCharacters.has(seat.seatId)).toBe(true);
        expect(
          room.state.seats.some(
            (candidate) =>
              candidate.seatId === seat.seatId &&
              candidate.presence !== 'revoked',
          ),
        ).toBe(true);
        expect(
          (await originalLoadBindings(f.sessionId)).some(
            (binding) => binding.accountId === joiner,
          ),
        ).toBe(true);
        const boundSnapshots = await db.query<{ seq: string }>(
          `SELECT s.seq::text AS seq FROM snapshots s
           JOIN events e ON e.session_id=s.session_id AND e.seq=s.seq
           WHERE s.session_id=$1 AND e.type='SeatCharacterBound'
             AND e.payload->>'seatId'=$2`,
          [f.sessionId, seat.seatId],
        );
        expect(boundSnapshots.rows).toHaveLength(1);
      } finally {
        store.writeTurn = originalWriteTurn;
        store.loadSessionMode = originalLoadMode;
        store.loadActiveSeatCharacterBindings = originalLoadBindings;
        await room.drain();
      }
    },
  );

  it('refuses explicit binding while a session remains solo', async () => {
    const f = await solo();
    const room = await open(f);
    await room.seat(f.owner, 'Owner');
    await expect(
      room.bindSeatCharacter(
        f.owner,
        f.ownerChar.character.id,
        f.ownerChar.revision,
        async () => true,
        randomUUID(),
      ),
    ).rejects.toThrow(/SOLO_SESSION/);
    expect(await modeOf(f.sessionId)).toBe('solo');
    await room.drain();
  }, 60_000);

  it('rejects non-host approval without admitting the joiner', async () => {
    const f = await solo();
    const room = await open(f);
    await room.seat(f.owner, 'Owner');
    const joiner = await account();
    const jc = await character(joiner, 0x54);
    await setScene(room);
    const req = await room.requestLateJoin(
      joiner,
      jc.character.id,
      jc.revision,
      randomUUID(),
      'Joiner',
    );
    await expect(
      room.approveLateJoin(joiner, randomUUID(), req),
    ).rejects.toThrow();
    expect(
      (await rows(f.sessionId)).some((e) => e.type === 'LateJoinApproved'),
    ).toBe(false);
    await room.submitAction(f.owner, randomUUID(), 'close the scene', 'Owner');
    await new Promise((r) => setTimeout(r, 200));
    expect(room.state.seats.some((s) => s.accountId === joiner)).toBe(false);
    expect(await modeOf(f.sessionId)).toBe('solo');
    await room.drain();
  }, 60_000);

  it('does not admit an expired late-join request', async () => {
    const f = await solo();
    const room = await open(f);
    await room.seat(f.owner, 'Owner');
    const joiner = await account();
    const jc = await character(joiner, 0x55);
    await setScene(room);
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const req = await room.requestLateJoin(
        joiner,
        jc.character.id,
        jc.revision,
        randomUUID(),
        'Joiner',
      );
      vi.setSystemTime(Date.now() + 11 * 60_000);
      await room.approveLateJoin(f.owner, randomUUID(), req);
      await room.submitAction(
        f.owner,
        randomUUID(),
        'close the scene',
        'Owner',
      );
    } finally {
      vi.useRealTimers();
    }
    await new Promise((r) => setTimeout(r, 200));
    const ev = await rows(f.sessionId);
    expect(room.state.seats.some((s) => s.accountId === joiner)).toBe(false);
    expect(
      ev.some(
        (e) =>
          e.type === 'SeatJoined' &&
          (e.payload as { accountId?: string }).accountId === joiner,
      ),
    ).toBe(false);
    expect(await modeOf(f.sessionId)).toBe('solo');
    await room.drain();
  }, 60_000);

  it('keeps the session solo when a stale bind revokes the pending seat', async () => {
    const f = await solo();
    const room = await open(f);
    await room.seat(f.owner, 'Owner');
    const joiner = await account();
    const jc = await character(joiner, 0x56);
    await setScene(room);
    const req = await room.requestLateJoin(
      joiner,
      jc.character.id,
      jc.revision,
      randomUUID(),
      'Joiner',
    );
    await repo.saveOwnedCharacter(
      joiner,
      { ...jc.character, name: 'Changed Name' },
      jc.revision,
    );
    await room.approveLateJoin(f.owner, randomUUID(), req);
    await room.submitAction(f.owner, randomUUID(), 'close the scene', 'Owner');
    expect(
      await waitFor(() =>
        room.state.seats.some((seat) => seat.accountId === joiner),
      ),
    ).toBe(true);
    const staleSeat = room.state.seats.find(
      (seat) => seat.accountId === joiner,
    )!;
    const staleConnection = conn();
    await room.subscribe(joiner, staleConnection, -1);
    const staleSync = staleConnection.msgs.find(
      (message) => (message as { type?: string }).type === 'StateSync',
    ) as { seq: number } | undefined;
    expect(staleSync).toBeDefined();
    await room.acknowledgeLateJoinSnapshot(
      joiner,
      staleSeat.seatId,
      staleSync!.seq,
    );
    await room.submitAction(
      f.owner,
      randomUUID(),
      'close the next scene',
      'Owner',
    );
    expect(
      await waitFor(async () =>
        (await rows(f.sessionId)).some(
          (event) => event.type === 'LateJoinExpired',
        ),
      ),
    ).toBe(true);
    const ev = await rows(f.sessionId);
    const expired = ev.find((event) => event.type === 'LateJoinExpired');
    expect(expired?.payload.reason).toBe('STALE_REVISION');
    expect(ev.some((event) => event.type === 'SeatRevoked')).toBe(true);
    expect(ev.some((event) => event.type === 'SeatCharacterBound')).toBe(false);
    expect(ev.some((event) => event.type === 'LateJoinSpawned')).toBe(false);
    const gameEngine = (
      room.state.gameState as {
        gameEngine?: { entities?: Array<{ id: string }> };
      }
    ).gameEngine;
    expect(
      gameEngine?.entities?.some(
        (entity) => entity.id === `ent_seat_${staleSeat.seatId}`,
      ),
    ).not.toBe(true);
    await expect(
      room.submitAction(joiner, randomUUID(), 'revoked seat action', 'Joiner'),
    ).rejects.toThrow();
    expect(
      (await store.loadActiveSeatCharacterBindings(f.sessionId)).some(
        (binding) => binding.accountId === joiner,
      ),
    ).toBe(false);
    expect(room.state.seats.some((seat) => seat.accountId === joiner)).toBe(
      false,
    );
    expect(await modeOf(f.sessionId)).toBe('solo');
    await room.drain();
  }, 60_000);

  it('fences actions and game-state writes after lease takeover', async () => {
    const f = await solo();
    const room = await open(f);
    await room.seat(f.owner, 'Owner');
    await setScene(room);
    const before = (await rows(f.sessionId)).length;
    await db.query(
      "UPDATE session_lease SET node_id='usurper', epoch=2 WHERE session_id=$1",
      [f.sessionId],
    );
    const gs = await room
      .persistGameState({ sceneId: 'x', gameEngine: { map, entities: [] } })
      .then(
        () => 'ok',
        (e: Error) => 'rejected:' + e.message,
      );
    expect(gs.startsWith('rejected')).toBe(true);
    expect((await rows(f.sessionId)).length).toBe(before);
    await room
      .submitAction(f.owner, randomUUID(), 'after takeover', 'Owner')
      .then(
        () => 'ok',
        (e: Error) => 'rejected:' + e.message,
      );
    await new Promise((r) => setTimeout(r, 1500));
    const after = await rows(f.sessionId);
    expect(
      after
        .slice(before)
        .some(
          (e) => e.type === 'GameStateCommitted' || e.type === 'ActionAccepted',
        ),
    ).toBe(false);
    expect(await modeOf(f.sessionId)).toBe('solo');
    await room.drain();
  }, 60_000);
});
