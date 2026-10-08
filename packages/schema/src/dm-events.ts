import { z } from 'zod';
import { DMToolErrorCodeSchema, DMToolName } from './dm-tools.js';

const input = z
  .object({
    playerId: z.string().min(1),
    actionId: z.string().min(1),
    text: z.string(),
  })
  .strict();
export const TurnStartedSchema = z
  .object({
    type: z.literal('TurnStarted'),
    turnId: z.string().min(1),
    seed: z.string().regex(/^0x[0-9a-f]{16}$/),
    promptPrefixHash: z.string().regex(/^sha256:[a-f0-9]{8,}$/),
    inputs: z.array(input),
  })
  .strict();
export const NarrationChunkSchema = z
  .object({
    type: z.literal('NarrationChunk'),
    turnId: z.string().min(1),
    text: z.string().min(1),
    index: z.int().nonnegative(),
  })
  .strict();
export const NarrationCompletedSchema = z
  .object({
    type: z.literal('NarrationCompleted'),
    turnId: z.string().min(1),
    text: z.string(),
    words: z.int().nonnegative(),
  })
  .strict();
export const TurnRevertedSchema = z
  .object({
    type: z.literal('TurnReverted'),
    turnId: z.string().min(1),
    revertedTurnId: z.string().min(1),
    newSeed: z
      .string()
      .regex(/^0x[0-9a-f]{16}$/)
      .optional(),
  })
  .strict();
export const ToolRejectedSchema = z
  .object({
    type: z.literal('ToolCallRejected'),
    turnId: z.string().min(1),
    toolName: z.string().min(1),
    error: DMToolErrorCodeSchema,
    attempt: z.int().positive(),
    argHash: z.string().min(1),
  })
  .strict();
export const SceneClosedSchema = z
  .object({
    type: z.literal('SceneClosed'),
    sceneId: z.string().min(1),
    summary: z.string().max(1200),
  })
  .strict();
export const RecapReadySchema = z
  .object({
    type: z.literal('RecapReady'),
    sessionId: z.string().min(1),
    recap: z.string().max(1500),
  })
  .strict();
export const TurnFallbackSchema = z
  .object({
    type: z.literal('TurnFallback'),
    turnId: z.string().min(1),
    reason: z.enum(['no-narration', 'endpoint-error', 'budget-exhausted']),
  })
  .strict();
export const NarrationTruncatedSchema = z
  .object({
    type: z.literal('NarrationTruncated'),
    turnId: z.string().min(1),
    words: z.int().nonnegative(),
  })
  .strict();
export const PromptOverBudgetSchema = z
  .object({
    type: z.literal('PromptOverBudget'),
    turnId: z.string().min(1),
    tokens: z.int().positive(),
    trimsApplied: z.array(z.string()),
  })
  .strict();
export const EntityDownedSchema = z
  .object({
    type: z.literal('EntityDowned'),
    entityId: z.string().min(1),
    by: z.string().min(1),
  })
  .strict();
export const TurnCommittedSchema = z
  .object({
    type: z.literal('TurnCommitted'),
    turnId: z.string().min(1),
    eventSeqRange: z.tuple([z.int().nonnegative(), z.int().nonnegative()]),
    usage: z
      .object({
        in: z.int().nonnegative(),
        out: z.int().nonnegative(),
        cacheRead: z.int().nonnegative().optional(),
      })
      .strict(),
  })
  .strict();
export const DMTurnEventSchema = z.discriminatedUnion('type', [
  TurnStartedSchema,
  NarrationChunkSchema,
  NarrationCompletedSchema,
  TurnRevertedSchema,
  ToolRejectedSchema,
  SceneClosedSchema,
  RecapReadySchema,
  TurnFallbackSchema,
  NarrationTruncatedSchema,
  PromptOverBudgetSchema,
  EntityDownedSchema,
  TurnCommittedSchema,
]);
export type DMTurnEvent = z.infer<typeof DMTurnEventSchema>;
export type DMToolNameEvent = DMToolName;
