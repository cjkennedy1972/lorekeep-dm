import { z } from 'zod';
import { AccountIdSchema, SeatIdSchema, SessionIdSchema } from './ids.js';

export const PresenceSchema = z.enum(['online', 'away', 'offline']);
export const SeatSchema = z.object({
  seatId: SeatIdSchema,
  accountId: AccountIdSchema,
  displayName: z.string().min(1),
  presence: PresenceSchema,
  // Private account preference; omitted from the shared room-state wire view.
  matureOptOut: z.boolean().optional(),
});
export const RoundSubmissionSchema = z.object({
  seatId: SeatIdSchema,
  accountId: AccountIdSchema,
  actionId: z.uuid(),
  originalActionId: z.uuid(),
  actionIds: z.array(z.uuid()),
  text: z.string().min(1).max(4000),
  playerName: z.string().min(1),
  receiptSeq: z.int().positive(),
  editedAt: z.number().optional(),
});
export const RoundStateSchema = z.object({
  roundId: z.uuid(),
  status: z.enum(['open', 'closing', 'resolving', 'resolved']),
  eligibleSeatIds: z.array(SeatIdSchema),
  deadlineAt: z.number().nullable(),
  remainingMs: z.number().nonnegative().optional(),
  closeReason: z.enum(['all-submitted', 'timer', 'resolve-now']).optional(),
  submissions: z.array(RoundSubmissionSchema),
  queuedSubmissions: z.array(RoundSubmissionSchema),
});
export const ClosedRoundSubmissionSchema = z.object({
  accountId: AccountIdSchema,
  actionIds: z.array(z.uuid()),
});
export const RoomStateSchema = z.object({
  sessionId: SessionIdSchema,
  phase: z.literal('lobby'),
  seats: z.array(SeatSchema).max(6),
  round: RoundStateSchema.optional(),
  roundsEnabled: z.boolean().optional(),
  /** Host setting for rounds opened after the current one; null disables the deadline. */
  roundDurationMs: z.number().int().nonnegative().nullable().optional(),
  closedRoundSubmissions: z.array(ClosedRoundSubmissionSchema).optional(),
  gameState: z.unknown().optional(),
  /** X-card presses so far, and the count the DM has already steered away from. */
  xCard: z
    .object({
      requested: z.int().nonnegative(),
      steered: z.int().nonnegative(),
    })
    .optional(),
  /** Table pause: no new narration starts while set. Shared, so every seat sees it. */
  paused: z.boolean().optional(),
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
  /** Host's nullable lower-tier cap; omitted outside lobby detail views. */
  tierCap: z.enum(['family', 'standard']).nullable().optional(),
});
export const RoomOutputSchema = z.object({ room: RoomInfoSchema });
export const RoomsOutputSchema = z.object({ rooms: z.array(RoomInfoSchema) });
export type CreateRoomInput = z.infer<typeof CreateRoomInputSchema>;
export type RoomInfo = z.infer<typeof RoomInfoSchema>;
