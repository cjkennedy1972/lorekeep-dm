import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Room, type Connection, type RoomStore } from '../../src/room/Room.js';
import type { LatestState, StoredEvent } from '../../src/persistence/index.js';
import { joinSeated } from '../helpers/room.js';

const sessionId = randomUUID();
const lease = {
  sessionId,
  nodeId: 'history',
  epoch: 1,
  expiresAt: new Date(Date.now() + 60_000),
};
const rows = [
  { turnId: 'old', narration: 'Old scene.', tier: 'standard' as const },
  { turnId: 'mature', narration: 'Mature scene.', tier: 'mature' as const },
  {
    turnId: 'new',
    narration: 'New scene.',
    tier: 'family' as const,
    actionText: 'I search the room.',
  },
];

function setup(
  eligible: boolean,
  ownerId: string,
  historyRows: typeof rows | null = rows,
) {
  const events: StoredEvent[] = [];
  const store: RoomStore = {
    async isAccountActive() {
      return true;
    },
    async loadLatest(): Promise<LatestState> {
      return { snapshot: null, events: [] };
    },
    async writeTurn(_id, inputs) {
      const stored = inputs.map((input, index) => ({
        ...input,
        seq: events.length + index + 1,
        sessionId,
        ts: new Date(),
      })) as StoredEvent[];
      events.push(...stored);
      return { events: stored };
    },
    ...(historyRows
      ? {
          async loadNarrationHistory(_sessionId: string, accountId: string) {
            return historyRows.map((row) => {
              const { actionText, ...publicRow } = row;
              return accountId === ownerId
                ? { ...publicRow, ...(actionText ? { actionText } : {}) }
                : publicRow;
            });
          },
        }
      : {}),
    async matureEligibleAccounts(accountIds) {
      return eligible ? accountIds : [];
    },
    async tableHostAccountId() {
      return undefined;
    },
  };
  return new Room(store, lease, { snapshot: null, events: [] });
}

function recorder() {
  const sent: { type: string; payload?: unknown }[] = [];
  return {
    sent,
    send(message: unknown) {
      sent.push(message as { type: string; payload?: unknown });
    },
  } satisfies Connection & { sent: { type: string; payload?: unknown }[] };
}

describe('narration history sync', () => {
  it('does not resend history to an existing seat when another seat joins', async () => {
    const room = setup(false, randomUUID());
    const seatA = randomUUID();
    const connectionA = recorder();
    await joinSeated(room, seatA, connectionA, 'A');
    const initialHistoryCount = connectionA.sent.filter(
      (message) => message.type === 'NarrationHistory',
    ).length;

    await joinSeated(room, randomUUID(), recorder(), 'B');

    expect(
      connectionA.sent.filter((message) => message.type === 'NarrationHistory'),
    ).toHaveLength(initialHistoryCount);
  });

  it('sends an empty history message on a same-sequence reconnect without stored narration', async () => {
    const accountId = randomUUID();
    const room = setup(false, accountId, null);
    const first = recorder();
    await joinSeated(room, accountId, first, 'Player');

    const reconnect = recorder();
    await room.subscribe(accountId, reconnect, room.seq);

    expect(
      reconnect.sent.find((message) => message.type === 'NarrationHistory')
        ?.payload,
    ).toEqual({ turns: [] });
  });

  it('sends bounded committed viewer history on reconnect and withholds mature narration when ineligible', async () => {
    const accountId = randomUUID();
    const room = setup(false, accountId);
    const connection = recorder();
    await joinSeated(room, accountId, connection, 'Player');
    const history = connection.sent.find(
      (message) => message.type === 'NarrationHistory',
    );
    expect(history?.payload).toEqual({
      turns: [
        { turnId: 'old', text: 'Old scene.', tier: 'standard' },
        {
          turnId: 'new',
          text: 'New scene.',
          tier: 'family',
          actionText: 'I search the room.',
        },
      ],
    });
    const guestId = randomUUID();
    const guest = recorder();
    await joinSeated(room, guestId, guest, 'Guest');
    expect(
      guest.sent.find((message) => message.type === 'NarrationHistory')
        ?.payload,
    ).toEqual({
      turns: [
        { turnId: 'old', text: 'Old scene.', tier: 'standard' },
        { turnId: 'new', text: 'New scene.', tier: 'family' },
      ],
    });
  });

  it('scrubs concealed entity names and ids from replayed narration', async () => {
    const accountId = randomUUID();
    const room = setup(false, accountId, [
      {
        turnId: 'hidden',
        narration: 'Astra (ent_secret) watches.',
        tier: 'standard',
      },
    ]);
    (room.state as unknown as { gameState: unknown }).gameState = {
      concealed: [{ id: 'ent_secret', name: 'Astra' }],
    };
    const connection = recorder();
    await joinSeated(room, accountId, connection, 'Player');
    expect(
      (
        connection.sent.find((message) => message.type === 'NarrationHistory')
          ?.payload as { turns: { text: string }[] }
      ).turns[0]?.text,
    ).toBe('an unseen presence (an unseen presence) watches.');
  });

  it('caps replay payload characters across the bounded turn history', async () => {
    const accountId = randomUUID();
    const huge = Array.from({ length: 30 }, (_, index) => ({
      turnId: `turn-${index}`,
      narration: 'x'.repeat(2_000),
      tier: 'standard' as const,
    }));
    const room = setup(false, accountId, huge);
    const connection = recorder();
    await joinSeated(room, accountId, connection, 'Player');
    const turns = (
      connection.sent.find((message) => message.type === 'NarrationHistory')
        ?.payload as { turns: { text: string }[] }
    ).turns;
    expect(turns.length).toBeLessThanOrEqual(30);
    expect(
      turns.reduce((size, turn) => size + turn.text.length, 0),
    ).toBeLessThanOrEqual(24_000);
  });

  it('includes mature narration only for viewers eligible under live-delivery account rules', async () => {
    const accountId = randomUUID();
    const room = setup(true, accountId);
    const connection = recorder();
    await joinSeated(room, accountId, connection, 'Player');
    expect(
      connection.sent.find((message) => message.type === 'NarrationHistory')
        ?.payload,
    ).toMatchObject({
      turns: expect.arrayContaining([
        { turnId: 'mature', text: 'Mature scene.', tier: 'mature' },
      ]),
    });
  });
});
