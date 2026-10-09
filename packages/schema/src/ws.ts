import { z } from 'zod';
import { ActionIdSchema, SeatIdSchema } from './ids.js';
import { PresenceSchema, RoomStateSchema } from './room.js';

export const ClientEnvelopeSchema = z.object({
  actionId: ActionIdSchema,
  type: z.string().min(1),
  payload: z.record(z.string(), z.unknown()),
  lastSeq: z.int().nonnegative(),
});
export const PlayerActionSchema = z
  .object({
    actionId: ActionIdSchema,
    type: z.literal('PlayerAction'),
    payload: z.object({ text: z.string().trim().min(1).max(4000) }),
    lastSeq: z.int().nonnegative(),
  })
  .strict();
export const StateSyncSchema = z.object({
  seq: z.int().nonnegative(),
  type: z.literal('StateSync'),
  payload: z.object({ state: RoomStateSchema }),
});
export const PresenceChangedSchema = z.object({
  seq: z.int().nonnegative(),
  type: z.literal('PresenceChanged'),
  payload: z.object({ seatId: SeatIdSchema, presence: PresenceSchema }),
});
export const ErrorMessageSchema = z.object({
  seq: z.int().nonnegative(),
  type: z.literal('Error'),
  payload: z.object({
    code: z.string().min(1),
    message: z.string().min(1),
    actionId: ActionIdSchema.optional(),
  }),
});
export const ServerMessageSchema = z.discriminatedUnion('type', [
  z.object({
    seq: z.int().nonnegative(),
    type: z.enum([
      'ActionQueued',
      'TurnThinking',
      'RollEvent',
      'NarrationChunk',
      'NarrationCompleted',
      'ToolRejected',
    ]),
    payload: z.record(z.string(), z.unknown()),
  }),
  StateSyncSchema,
  PresenceChangedSchema,
  ErrorMessageSchema,
]);
export type ClientEnvelope = z.infer<typeof ClientEnvelopeSchema>;
export type StateSync = z.infer<typeof StateSyncSchema>;
export type PresenceChanged = z.infer<typeof PresenceChangedSchema>;
export type ErrorMessage = z.infer<typeof ErrorMessageSchema>;
export type ServerMessage = z.infer<typeof ServerMessageSchema>;
