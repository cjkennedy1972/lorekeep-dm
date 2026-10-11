import { z } from 'zod';
import { AccountIdSchema, SeatIdSchema, SessionIdSchema } from './ids.js';

export const PresenceSchema = z.enum(['online', 'away', 'offline']);
export const SeatSchema = z.object({
  seatId: SeatIdSchema,
  accountId: AccountIdSchema,
  displayName: z.string().min(1),
  presence: PresenceSchema,
  matureOptOut: z.boolean().default(false),
});
export const RoomStateSchema = z.object({
  sessionId: SessionIdSchema,
  phase: z.literal('lobby'),
  seats: z.array(SeatSchema).max(6),
  gameState: z.unknown().optional(),
  openClarifications: z
    .record(
      z.string(),
      z.object({
        accountId: z.string().min(1),
        playerName: z.string(),
        text: z.string(),
        question: z.string().min(1),
        deadlineAt: z.number(),
      }),
    )
    .optional(),
});
export type Presence = z.infer<typeof PresenceSchema>;
export type Seat = z.infer<typeof SeatSchema>;
export type RoomState = z.infer<typeof RoomStateSchema>;

export const CreateRoomInputSchema = z.object({
  name: z.string().trim().min(1).max(80),
});
/** `code` is the plaintext invite secret; only present in the response that minted it (host only). */
export const RoomInfoSchema = z.object({
  id: SessionIdSchema,
  name: z.string().min(1),
  isHost: z.boolean(),
  code: z.string().optional(),
});
export const RoomOutputSchema = z.object({ room: RoomInfoSchema });
export const RoomsOutputSchema = z.object({ rooms: z.array(RoomInfoSchema) });
export type CreateRoomInput = z.infer<typeof CreateRoomInputSchema>;
export type RoomInfo = z.infer<typeof RoomInfoSchema>;
