import { z } from 'zod';
import { SessionIdSchema, TurnIdSchema } from './ids.js';
import { GridPosSchema } from './combat.js';

export const EventRowSchema = z.object({
  sessionId: SessionIdSchema,
  seq: z.int().positive(),
  turnId: TurnIdSchema,
  type: z.string().min(1),
  payload: z.record(z.string(), z.unknown()),
  ts: z.iso.datetime(),
});
export type EventRow = z.infer<typeof EventRowSchema>;

// M1 engine events (architecture 15.6), discriminated on `type`.
const ev = <T extends string, S extends z.ZodRawShape>(type: T, shape: S) =>
  z.object({ type: z.literal(type), ...shape });
const entityId = z.string().min(1);
const pos = GridPosSchema;
export const ContentTierSchema = z.enum(['family', 'standard', 'mature']);
export type ContentTier = z.infer<typeof ContentTierSchema>;

export const EngineEventSchema = z.discriminatedUnion('type', [
  ev('RollEvent', {
    actorId: entityId,
    label: z.string(),
    dice: z.string().min(1),
    rolls: z.array(z.int()).optional(),
    modifier: z.int().optional(),
    total: z.int().optional(),
    targetId: entityId.optional(),
    hit: z.boolean().optional(),
    damage: z.int().nonnegative().optional(),
    dc: z.int().optional(),
    success: z.boolean().optional(),
  }),
  ev('ConcentrationDropped', {
    entityId,
    spellId: z.string().min(1).optional(),
  }),
  ev('CombatStarted', {
    combatId: z.string().min(1).optional(),
    entityIds: z.array(entityId).optional(),
    encounterId: z.string().min(1).optional(),
    order: z.array(entityId).optional(),
  })
    .strict()
    .refine(
      (event) =>
        (event.combatId !== undefined && event.entityIds !== undefined) ||
        (event.encounterId !== undefined && event.order !== undefined),
    ),
  ev('InitiativeRolled', { entityId, total: z.int() }),
  ev('ReactionAvailable', { entityId, trigger: z.string().min(1) }),
  ev('ReactionResolved', {
    entityId,
    used: z.boolean(),
    reactionId: z.string().optional(),
  }),
  ev('CombatEnded', {
    combatId: z.string().min(1).optional(),
    encounterId: z.string().min(1).optional(),
  })
    .strict()
    .refine(
      (event) =>
        event.combatId !== undefined || event.encounterId !== undefined,
    ),
  ev('TurnOpened', {
    turnId: z.string().min(1),
    entityId,
    /** Absolute wall-clock deadline in Unix epoch milliseconds; never monotonic. Null when the turn timer is off. */
    deadline: z.number().int().nonnegative().nullable(),
  }).strict(),
  ev('TurnResolved', {
    turnId: z.string().min(1),
    entityId,
    eventIds: z.array(z.string().min(1)),
  }).strict(),
  /** ADR-033 §3 / ADR-034 §5 prompt lifecycle for party combat; replaces ReactionAvailable/ReactionResolved there. */
  ev('ReactionPromptOpened', {
    promptId: z.string().min(1),
    reactorEntityId: entityId,
    /** Absolute wall-clock epoch ms at which the window closes. */
    deadline: z.number().int().nonnegative(),
  }).strict(),
  ev('ReactionAnswered', {
    promptId: z.string().min(1),
    choice: z.enum(['take', 'decline']),
  }).strict(),
  ev('ReactionDeclined', {
    promptId: z.string().min(1),
    cause: z.enum([
      'timeout',
      'presence',
      'no-controller',
      'auto',
      'cap',
      'combat-ended',
      'restart',
    ]),
  }).strict(),
  ev('TurnTimedOut', {
    turnId: z.string().min(1),
    entityId,
    action: z.enum(['dodge', 'hold']),
  }).strict(),
  ev('MapLoaded', { mapId: z.string().min(1) }),
  ev('EntityPlaced', { entityId, pos }),
  ev('LateJoinSpawned', {
    seatId: z.uuid(),
    entityId,
    sceneId: z.string().min(1),
    pos,
    initiativeEffectiveRound: z.int().positive().optional(),
  }),
  ev('EntityMoved', {
    entityId,
    path: z.array(pos).min(1),
    cost: z.int().nonnegative(),
  }),
  ev('MoveStarted', {
    entityId,
    path: z.array(pos).min(2),
    // Retain optionality for historical movement events without lifecycle IDs.
    turnId: z.string().min(1).optional(),
  }).strict(),
  ev('MoveEnded', {
    entityId,
    turnId: z.string().min(1).optional(),
    reason: z.enum(['complete', 'blocked', 'incapacitated', 'timed-out']),
  }).strict(),
  ev('OpportunityTriggered', { moverId: entityId, attackerId: entityId }),
  ev('EntityRevealed', {
    entityId,
    cause: z.enum(['bump', 'attack', 'opportunity']),
  }).strict(),
  ev('AreaResolved', { cells: z.array(pos), affected: z.array(entityId) }),
  ev('HpChanged', {
    entityId,
    from: z.int().optional(),
    to: z.int().optional(),
    damage: z.int().optional(),
    damageType: z.string().optional(),
    amount: z.int().optional(),
    kind: z.enum(['damage', 'healing']).optional(),
    // Read compatibility for legacy event rows; current combat producers use from/to.
    delta: z.int().optional(),
    hp: z.int().optional(),
  }).refine(
    (event) =>
      (event.from !== undefined && event.to !== undefined) ||
      (event.delta !== undefined && event.hp !== undefined),
    'HpChanged requires from/to or legacy delta/hp values',
  ),
  ev('ConditionApplied', {
    entityId,
    conditionId: z.string().min(1),
    source: z.string().optional(),
  }),
  ev('ConditionRemoved', { entityId, conditionId: z.string().min(1) }),
  ev('SlotSpent', { entityId, level: z.int().min(1).max(9) }),
  ev('ContentTierChanged', { from: ContentTierSchema, to: ContentTierSchema }),
]);
export type EngineEvent = z.infer<typeof EngineEventSchema>;
