import { z } from 'zod';
import { ActionIdSchema, SeatIdSchema } from './ids.js';
import { PresenceSchema, RoomStateSchema } from './room.js';
import { GridPosSchema } from './combat.js';

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
export const WithdrawActionSchema = z
  .object({
    actionId: ActionIdSchema,
    type: z.literal('WithdrawAction'),
    payload: z.object({ withdrawnActionId: ActionIdSchema }),
    lastSeq: z.int().nonnegative(),
  })
  .strict();
export const EditActionSchema = z
  .object({
    actionId: ActionIdSchema,
    type: z.literal('EditAction'),
    payload: z.object({
      editedActionId: ActionIdSchema,
      text: z.string().trim().min(1).max(4000),
    }),
    lastSeq: z.int().nonnegative(),
  })
  .strict();
export const ClarificationAnswerSchema = z
  .object({
    actionId: ActionIdSchema,
    type: z.literal('ClarificationAnswer'),
    payload: z.object({
      actionId: ActionIdSchema,
      answer: z.string().trim().min(1).max(4000),
    }),
    lastSeq: z.int().nonnegative(),
  })
  .strict();
const NormalizedChatTextSchema = z
  .string()
  .transform((text) => text.normalize('NFC').trim())
  .pipe(z.string().min(1).max(2000));
export const ChatSendSchema = z
  .object({
    actionId: ActionIdSchema,
    type: z.literal('ChatSend'),
    payload: z.object({ text: NormalizedChatTextSchema }).strict(),
    lastSeq: z.int().nonnegative(),
  })
  .strict();
export const ChatHistoryRequestSchema = z
  .object({
    actionId: ActionIdSchema,
    type: z.literal('ChatHistoryRequest'),
    payload: z.object({}).strict(),
    lastSeq: z.int().nonnegative(),
  })
  .strict();
export const MuteChatSchema = z
  .object({
    actionId: ActionIdSchema,
    type: z.literal('MuteChat'),
    payload: z.object({ seatId: SeatIdSchema, muted: z.boolean() }).strict(),
    lastSeq: z.int().nonnegative(),
  })
  .strict();
export const ChatMessageSchema = z
  .object({
    messageId: z.uuid(),
    roomId: z.uuid(),
    seatId: SeatIdSchema,
    receiptSeq: z.int().positive(),
    receivedAt: z.int().nonnegative(),
    text: NormalizedChatTextSchema,
    channel: z.literal('ooc'),
    gateDecision: z
      .object({
        verdict: z.literal('allow'),
        moderationLogId: z.uuid().optional(),
      })
      .strict(),
  })
  .strict();
export const ChatHistoryEntrySchema = z
  .object({ seq: z.int().positive(), message: ChatMessageSchema })
  .strict();
export const CombatCommandSchema = z
  .object({
    actionId: ActionIdSchema,
    type: z.literal('CombatCommand'),
    payload: z.discriminatedUnion('command', [
      z.object({ command: z.literal('options') }).strict(),
      z
        .object({ command: z.literal('move'), destination: GridPosSchema })
        .strict(),
      z
        .object({
          command: z.literal('attack'),
          targetId: z.string().min(1),
          attackId: z.string().min(1),
        })
        .strict(),
      z
        .object({
          command: z.literal('cast'),
          spellId: z.string().min(1),
          slotLevel: z.int().min(0).max(9),
          target: z.discriminatedUnion('kind', [
            z.object({ kind: z.literal('self') }).strict(),
            z
              .object({ kind: z.literal('entity'), ref: z.string().min(1) })
              .strict(),
            z
              .object({ kind: z.literal('anchor'), ref: z.string().min(1) })
              .strict(),
            z
              .object({ kind: z.literal('option'), ref: z.string().min(1) })
              .strict(),
          ]),
        })
        .strict(),
      z.object({ command: z.literal('end-turn') }).strict(),
      z
        .object({
          command: z.literal('reaction'),
          reactionId: z.string().min(1),
          choice: z.enum(['take', 'decline']),
        })
        .strict(),
    ]),
    lastSeq: z.int().nonnegative(),
  })
  .strict();
export const XCardSchema = z
  .object({
    actionId: ActionIdSchema,
    type: z.literal('XCard'),
    payload: z.object({}).strict(),
    lastSeq: z.int().nonnegative(),
  })
  .strict();
export const PauseTableSchema = z
  .object({
    actionId: ActionIdSchema,
    type: z.literal('PauseTable'),
    payload: z.object({ paused: z.boolean() }).strict(),
    lastSeq: z.int().nonnegative(),
  })
  .strict();
export const ResolveNowSchema = z
  .object({
    actionId: ActionIdSchema,
    type: z.literal('ResolveNow'),
    payload: z.object({}).strict(),
    lastSeq: z.int().nonnegative(),
  })
  .strict();
export const RewindTurnSchema = z
  .object({
    actionId: ActionIdSchema,
    type: z.literal('RewindTurn'),
    payload: z.object({}).strict(),
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
    type: z.literal('ChatMessage'),
    payload: ChatMessageSchema,
  }),
  z.object({
    seq: z.int().nonnegative(),
    type: z.literal('ChatHistory'),
    payload: z.object({ messages: z.array(ChatHistoryEntrySchema) }).strict(),
  }),
  z.object({
    seq: z.int().nonnegative(),
    type: z.enum([
      'ActionQueued',
      'RoundOpened',
      'RoundActionAccepted',
      'RoundActionQueued',
      'RoundActionEdited',
      'RoundActionWithdrawn',
      'RoundClosing',
      'RoundResolved',
      'RoundCompleted',
      'RoundClosedEmpty',
      'ActionWithdrawn',
      'ClarificationRequested',
      'TurnThinking',
      'RollEvent',
      'NarrationChunk',
      'NarrationCompleted',
      'TurnReverted',
      'ToolRejected',
      'ContentTierChanged',
      'SafetyFlag',
      'DeathSaveRequired',
      'TpkChoiceRequired',
    ]),
    payload: z.record(z.string(), z.unknown()),
  }),
  StateSyncSchema,
  z.object({
    seq: z.int().nonnegative(),
    type: z.literal('CombatTracker'),
    payload: z.record(z.string(), z.unknown()),
  }),
  z.object({
    seq: z.int().nonnegative(),
    type: z.literal('ReactionPrompt'),
    payload: z.record(z.string(), z.unknown()),
  }),
  z.object({
    seq: z.int().nonnegative(),
    type: z.literal('CombatOptions'),
    payload: z.record(z.string(), z.unknown()),
  }),
  z.object({
    seq: z.int().nonnegative(),
    type: z.literal('CombatEvents'),
    payload: z.object({ events: z.array(z.record(z.string(), z.unknown())) }),
  }),
  z.object({
    seq: z.int().nonnegative(),
    type: z.literal('CombatEnded'),
    payload: z.record(z.string(), z.unknown()),
  }),
  PresenceChangedSchema,
  ErrorMessageSchema,
]);
export type ClientEnvelope = z.infer<typeof ClientEnvelopeSchema>;
export type ChatMessage = z.infer<typeof ChatMessageSchema>;
export type ChatHistoryEntry = z.infer<typeof ChatHistoryEntrySchema>;
export type CombatCommand = z.infer<typeof CombatCommandSchema>;
export type StateSync = z.infer<typeof StateSyncSchema>;
export type PresenceChanged = z.infer<typeof PresenceChangedSchema>;
export type ErrorMessage = z.infer<typeof ErrorMessageSchema>;
export type ServerMessage = z.infer<typeof ServerMessageSchema>;
