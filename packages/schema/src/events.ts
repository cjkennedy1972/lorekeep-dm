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
    rolls: z.array(z.int()),
    modifier: z.int(),
    total: z.int(),
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
  ev('AreaResolved', { cells: z.array(pos), affected: z.array(entityId) }),
  ev('HpChanged', { entityId, delta: z.int(), hp: z.int() }),
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
