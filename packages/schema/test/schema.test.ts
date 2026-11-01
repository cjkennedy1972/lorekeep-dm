import { expect, test } from 'vitest';
import type { Account } from '../src/accounts.js';
import {
  AccountIdSchema,
  SessionIdSchema,
  TurnIdSchema,
  ActionIdSchema,
  SeatIdSchema,
  RoomStateSchema,
  PresenceSchema,
  SeatSchema,
  ClientEnvelopeSchema,
  EditActionSchema,
  RewindTurnSchema,
  StateSyncSchema,
  PresenceChangedSchema,
  ErrorMessageSchema,
  ServerMessageSchema,
  EventRowSchema,
  SignupInputSchema,
  LoginInputSchema,
  AccountSchema,
  SignupOutputSchema,
  LoginOutputSchema,
  MeOutputSchema,
} from '../src/index.js';

const uuid = '123e4567-e89b-42d3-a456-426614174000';
const account = {
  id: uuid,
  email: 'a@example.test',
  displayName: 'A',
  isAdult: true,
  ageCheckedAt: '2026-10-06T00:00:00Z',
};
const seat = {
  seatId: uuid,
  accountId: uuid,
  displayName: 'A',
  presence: 'online',
  matureOptOut: false,
};
const room = { sessionId: uuid, phase: 'lobby', seats: [seat] };
const cases = [
  [AccountIdSchema, uuid, 'bad'],
  [SessionIdSchema, uuid, 'bad'],
  [TurnIdSchema, uuid, 'bad'],
  [ActionIdSchema, uuid, 'bad'],
  [SeatIdSchema, uuid, 'bad'],
  [PresenceSchema, 'online', 'missing'],
  [SeatSchema, seat, { ...seat, presence: 'missing' }],
  [RoomStateSchema, room, { ...room, phase: 'combat' }],
  [
    ClientEnvelopeSchema,
    { actionId: uuid, type: 'Join', payload: {}, lastSeq: 0 },
    { actionId: uuid, type: 'Join', payload: {}, lastSeq: -1 },
  ],
  [
    RewindTurnSchema,
    { actionId: uuid, type: 'RewindTurn', payload: {}, lastSeq: 0 },
    {
      actionId: uuid,
      type: 'RewindTurn',
      payload: { turnId: uuid },
      lastSeq: 0,
    },
  ],
  [
    EditActionSchema,
    {
      actionId: uuid,
      type: 'EditAction',
      payload: { editedActionId: uuid, text: '  revised action  ' },
      lastSeq: 0,
    },
    {
      actionId: uuid,
      type: 'EditAction',
      payload: { editedActionId: uuid, text: '   ' },
      lastSeq: 0,
    },
  ],
  [
    StateSyncSchema,
    { seq: 0, type: 'StateSync', payload: { state: room } },
    { seq: 0, type: 'StateSync', payload: {} },
  ],
  [
    StateSyncSchema,
    {
      seq: 0,
      type: 'StateSync',
      payload: { state: room, boundSeatIds: [uuid] },
    },
    {
      seq: 0,
      type: 'StateSync',
      payload: { state: room, boundSeatIds: ['not-a-seat-id'] },
    },
  ],
  [
    StateSyncSchema,
    {
      seq: 0,
      type: 'StateSync',
      payload: {
        state: room,
        round: {
          roundId: uuid,
          status: 'open',
          eligibleSeatIds: [uuid],
          deadlineAt: null,
          submissions: [
            {
              seatId: uuid,
              actionId: uuid,
              originalActionId: uuid,
              actionIds: [uuid],
              playerName: 'A',
              receiptSeq: 1,
            },
          ],
          queuedSubmissions: [],
        },
      },
    },
    {
      seq: 0,
      type: 'StateSync',
      payload: { state: room, round: { roundId: 'bad' } },
    },
  ],
  [
    PresenceChangedSchema,
    {
      seq: 1,
      type: 'PresenceChanged',
      payload: { seatId: uuid, presence: 'away' },
    },
    {
      seq: 1,
      type: 'PresenceChanged',
      payload: { seatId: uuid, presence: 'gone' },
    },
  ],
  [
    ErrorMessageSchema,
    { seq: 1, type: 'Error', payload: { code: 'BAD', message: 'Bad' } },
    { seq: 1, type: 'Error', payload: { code: '', message: 'Bad' } },
  ],
  [
    ServerMessageSchema,
    { seq: 1, type: 'Error', payload: { code: 'BAD', message: 'Bad' } },
    { seq: 1, type: 'Unknown', payload: {} },
  ],
  [
    EventRowSchema,
    {
      sessionId: uuid,
      seq: 1,
      turnId: uuid,
      type: 'Joined',
      payload: {},
      ts: '2026-10-06T00:00:00Z',
    },
    {
      sessionId: uuid,
      seq: 0,
      turnId: uuid,
      type: 'Joined',
      payload: {},
      ts: '2026-10-06T00:00:00Z',
    },
  ],
  [
    SignupInputSchema,
    {
      email: account.email,
      password: 'long-password',
      displayName: 'A',
      birthdate: '1990-01-01',
    },
    {
      email: account.email,
      password: 'short',
      displayName: 'A',
      birthdate: '1990-01-01',
    },
  ],
  [
    LoginInputSchema,
    { email: account.email, password: 'secret' },
    { email: 'bad', password: 'secret' },
  ],
  [AccountSchema, account, { ...account, isAdult: 'yes' }],
  [
    SignupOutputSchema,
    { account },
    { account: { ...account, isAdult: 'yes' } },
  ],
  [LoginOutputSchema, { account }, { account: { ...account, isAdult: 'yes' } }],
  [MeOutputSchema, { account }, { account: { ...account, isAdult: 'yes' } }],
] as const;
for (const [schema, valid, invalid] of cases) {
  test(`${schema.description ?? 'schema'} accepts valid and rejects invalid`, () => {
    expect(schema.safeParse(valid).success).toBe(true);
    expect(schema.safeParse(invalid).success).toBe(false);
  });
}
test('round snapshot submissions reject private fields', () => {
  const result = StateSyncSchema.safeParse({
    seq: 0,
    type: 'StateSync',
    payload: {
      state: room,
      round: {
        roundId: uuid,
        status: 'open',
        eligibleSeatIds: [uuid],
        deadlineAt: null,
        submissions: [
          {
            seatId: uuid,
            actionId: uuid,
            originalActionId: uuid,
            actionIds: [uuid],
            playerName: 'A',
            receiptSeq: 1,
            accountId: uuid,
            text: 'private action',
          },
        ],
        queuedSubmissions: [],
      },
    },
  });
  expect(result.success).toBe(false);
});
test('room state round-trips JSON', () => {
  expect(
    RoomStateSchema.parse(
      JSON.parse(JSON.stringify(RoomStateSchema.parse(room))),
    ),
  ).toEqual(room);
});
test('account output strips birthdate', () => {
  const parsed = AccountSchema.parse({ ...account, birthdate: '1990-01-01' });
  expect(parsed).not.toHaveProperty('birthdate');
  // @ts-expect-error Account never exposes birthdate
  const birthdate = ({} as Account).birthdate;
  expect(birthdate).toBeUndefined();
});

test('validates bounded, tiered narration history messages', () => {
  expect(
    ServerMessageSchema.safeParse({
      seq: 12,
      type: 'NarrationHistory',
      payload: {
        turns: [
          {
            turnId: uuid,
            text: 'The gate opens.',
            tier: 'standard',
            actionText: 'I push the gate.',
          },
        ],
      },
    }).success,
  ).toBe(true);
  expect(
    ServerMessageSchema.safeParse({
      seq: 12,
      type: 'NarrationHistory',
      payload: { turns: [{ turnId: uuid, text: 'Secret.', tier: 'unknown' }] },
    }).success,
  ).toBe(false);
});

test('login email length is bounded to the RFC maximum', () => {
  const email = `a@${Array(127).fill('b').join('.')}`;
  expect(email.length).toBe(255);
  expect(
    LoginInputSchema.safeParse({ email, password: 'secret' }).success,
  ).toBe(false);
});
