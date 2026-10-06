import { z } from 'zod';
import { AccountIdSchema, SeatIdSchema, SessionIdSchema } from './ids.js';

export const PresenceSchema = z.enum(['online', 'away', 'offline']);
export const SeatSchema = z.object({
  seatId: SeatIdSchema,
  accountId: AccountIdSchema,
  displayName: z.string().min(1),
  presence: PresenceSchema,
});
export const RoomStateSchema = z.object({
  sessionId: SessionIdSchema,
  phase: z.literal('lobby'),
  seats: z.array(SeatSchema).max(6),
});
export type Presence = z.infer<typeof PresenceSchema>;
export type Seat = z.infer<typeof SeatSchema>;
export type RoomState = z.infer<typeof RoomStateSchema>;
