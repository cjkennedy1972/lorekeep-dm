import { z } from 'zod';
import { AccountIdSchema, SeatIdSchema, SessionIdSchema } from './ids.js';

export const PresenceSchema = z.enum([
  'connected',
  'returning',
  'disconnected',
  'away',
  'unknown',
  'revoked',
  // Read compatibility for rooms written before ADR-031; new transitions use
  // the six-state vocabulary above.
  'online',
  'offline',
]);
export const SeatSchema = z.object({
  seatId: SeatIdSchema,
  accountId: AccountIdSchema,
  displayName: z.string().min(1),
  presence: PresenceSchema,
  /** Public host-control state, refreshed by the serialized Room event log. */
  isHost: z.boolean().optional(),
  chatMuted: z.boolean().optional(),
  chatMutedUntil: z.number().nonnegative().nullable().optional(),
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
export const RestVoteSchema = z.object({
  voteId: z.uuid(),
  type: z.enum(['short', 'long']),
  deadlineAt: z.number().nullable(),
  remainingMs: z.number().nonnegative().optional(),
  openedByTurnId: z.uuid(),
  // Internal recovery data. Client state carries castSeatIds only.
  eligibleSeats: z.array(SeatIdSchema).optional(),
  ballots: z
    .array(z.object({ seat: SeatIdSchema, choice: z.enum(['yes', 'no']) }))
    .optional(),
  tieBreak: z.enum(['yes', 'no']).optional(),
  castSeatIds: z.array(SeatIdSchema).optional(),
});
export const RestVoteResultSchema = z.object({
  voteId: z.uuid(),
  type: z.enum(['short', 'long']),
  outcome: z.enum(['passed', 'failed']),
  closeReason: z.enum([
    'majority',
    'no-majority-early',
    'no-majority',
    'host-tiebreak',
    'tie-failed',
    'expired',
    'cancelled',
    'cancelled-combat',
  ]),
});
export const RoomStateSchema = z.object({
  sessionId: SessionIdSchema,
  phase: z.literal('lobby'),
  seats: z.array(SeatSchema).max(6),
  /** Revoked seats remain in durable room history but cannot control or chat. */
  revokedSeats: z.array(SeatSchema).optional(),
  round: RoundStateSchema.optional(),
  restVote: RestVoteSchema.optional(),
  restVoteCount: z.int().nonnegative().optional(),
  restVoteLastClosedAt: z.number().nonnegative().optional(),
  /** Most recent result for the DM's next-turn context; not a rest mechanic. */
  lastRestVoteResult: RestVoteResultSchema.optional(),
  lastRestVoteResultTurnId: z.uuid().optional(),
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
  pauseCause: z.enum(['host', 'no-connected-seats']).optional(),
  spotlightTurn: z.number().int().nonnegative().optional(),
  spotlightCursor: z.number().int().nonnegative().optional(),
  /** Last committed presence-event time per seat, used to enforce ADR-031 §2.8. */
  presenceEventAt: z.record(z.string(), z.number().nonnegative()).optional(),
  presenceEventType: z
    .record(
      z.string(),
      z.enum([
        'PresenceChanged',
        'SeatDisconnected',
        'SeatAway',
        'SeatReconnected',
      ]),
    )
    .optional(),
  /** Last DM-turn index at which each account supplied player input. */
  spotlightActivity: z.record(z.string(), z.number().nonnegative()).optional(),
  ended: z.boolean().optional(),
  lateJoinRequests: z
    .array(
      z
        .object({
          requestId: z.uuid(),
          accountId: AccountIdSchema,
          displayName: z.string().min(1),
          matureOptOut: z.boolean().optional(),
          approved: z.boolean().optional(),
        })
        .strict(),
    )
    .optional(),
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
export type RestVoteState = z.infer<typeof RestVoteSchema>;
export type RestVoteResult = z.infer<typeof RestVoteResultSchema>;

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
