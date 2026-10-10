import { z } from 'zod';

const strict = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict();
// Player characters carry UUID ids (CharacterSchema); engine-spawned entities use ent_ refs.
const entityRef = z.union([
  z.string().regex(/^ent_[a-z0-9_-]{1,32}$/),
  z.uuid(),
]);
const targetRef = z.string().regex(/^(ent|feat|mk)_[a-z0-9_-]{1,32}$/);
const registryRef = (prefix: string) =>
  z.string().regex(new RegExp(`^${prefix}_[a-z0-9_-]{1,32}$`));
const catalog = (kind: string) =>
  z.string().regex(new RegExp(`^srd:${kind}/[a-z0-9-]+$`));
const ability = z.enum(['str', 'dex', 'con', 'int', 'wis', 'cha']);
const duration = z.enum([
  'until-save',
  'end-of-next-turn',
  '1-minute',
  '1-hour',
  'until-removed',
]);

export const DMToolArgsSchema = {
  close_scene: strict({
    summary: z.string().max(1200),
    nextSceneId: z.string().min(1).optional(),
  }),
  request_check: strict({
    actorId: entityRef,
    ability,
    skill: catalog('skill').optional(),
    dc: z.int().min(1).max(30),
    dcReason: z.string().min(8).max(120),
    advantage: z.enum(['normal', 'advantage', 'disadvantage']).optional(),
  }),
  request_save: strict({
    actorId: entityRef,
    ability,
    dc: z.int().min(1).max(30),
    source: z.string().min(3).max(80),
  }),
  attack: strict({
    attackerId: entityRef,
    targetId: entityRef,
    attackId: z.string().regex(/^srd:(weapon|attack)\/[a-z0-9-]+$/),
  }),
  cast_spell: strict({
    casterId: entityRef,
    spellId: catalog('spell'),
    slotLevel: z.int().min(0).max(9),
    target: z.discriminatedUnion('kind', [
      strict({ kind: z.literal('entity'), ref: entityRef }),
      strict({ kind: z.literal('anchor'), ref: targetRef }),
      strict({
        kind: z.literal('option'),
        ref: z.string().regex(/^opt_[a-z0-9]{4,8}$/),
      }),
      strict({ kind: z.literal('self') }),
    ]),
  }),
  apply_condition: strict({
    targetId: entityRef,
    conditionId: catalog('condition'),
    source: z.string().min(3).max(80),
    duration,
  }),
  remove_condition: strict({
    targetId: entityRef,
    conditionId: catalog('condition'),
    source: z.string().min(3).max(80),
    duration,
  }),
  start_combat: strict({
    enemies: z
      .array(
        strict({
          monsterId: catalog('monster'),
          count: z.int().min(1).max(8),
          spawnRef: targetRef.optional(),
        }),
      )
      .min(1)
      .max(12),
    ambushSide: z.enum(['party', 'enemies', 'none']).optional(),
  }),
  call_for_rest: strict({
    kind: z.enum(['short', 'long']),
    hitDiceToSpend: z.int().min(0).max(20).optional(),
  }),
  end_combat: strict({
    outcome: z.enum([
      'party-victory',
      'party-fled',
      'enemies-fled',
      'truce',
      'party-defeated',
    ]),
  }),
  move_to: strict({
    entityId: entityRef,
    targetRef,
    mode: z.enum(['adjacent', 'within', 'retreat', 'cover']),
  }),
  suggest_area_target: strict({
    spellId: catalog('spell'),
    casterId: entityRef,
    intent: z.enum([
      'max-enemies',
      'avoid-allies',
      'cover-retreat',
      'hit-target',
    ]),
    focusRef: targetRef.optional(),
  }).refine((v) => v.intent !== 'hit-target' || v.focusRef !== undefined, {
    message: 'focusRef is required for hit-target',
  }),
  grant_item: strict({
    targetId: entityRef,
    itemId: z.string().regex(/^srd:(item|currency)\/[a-z0-9-]+$/),
    qty: z.int().min(1).max(999),
  }),
  consume_item: strict({
    targetId: entityRef,
    itemId: z.string().regex(/^srd:(item|currency)\/[a-z0-9-]+$/),
    qty: z.int().min(1).max(999),
  }),
  update_quest: strict({
    questId: registryRef('quest'),
    status: z.enum(['available', 'active', 'completed', 'failed']),
    note: z.string().max(240).optional(),
  }),
  upsert_npc: strict({
    id: registryRef('npc'),
    name: z.string().min(2).max(60),
    role: z.string().max(60),
    disposition: z.enum([
      'hostile',
      'unfriendly',
      'neutral',
      'friendly',
      'ally',
    ]),
    facts: z.array(z.string().max(160)).max(8),
  }),
  upsert_location: strict({
    id: registryRef('loc'),
    name: z.string().min(2).max(60),
    role: z.string().max(60),
    facts: z.array(z.string().max(160)).max(8),
  }),
  set_flag: strict({
    flagId: registryRef('flag'),
    value: z.union([z.boolean(), z.string().max(64), z.int()]),
  }),
  rules_lookup: strict({ topic: z.string().min(3).max(80) }),
  log_ruling: strict({
    topic: z.string().min(1).max(80),
    ruling: z.string().min(1).max(400),
  }),
} as const;
export type DMToolName = keyof typeof DMToolArgsSchema;
export type DMToolArgs<N extends DMToolName> = z.infer<
  (typeof DMToolArgsSchema)[N]
>;
export const DMToolCallSchema = z.discriminatedUnion('name', [
  strict({
    name: z.literal('close_scene'),
    args: DMToolArgsSchema.close_scene,
  }),
  strict({
    name: z.literal('request_check'),
    args: DMToolArgsSchema.request_check,
  }),
  strict({
    name: z.literal('request_save'),
    args: DMToolArgsSchema.request_save,
  }),
  strict({ name: z.literal('attack'), args: DMToolArgsSchema.attack }),
  strict({ name: z.literal('cast_spell'), args: DMToolArgsSchema.cast_spell }),
  strict({
    name: z.literal('apply_condition'),
    args: DMToolArgsSchema.apply_condition,
  }),
  strict({
    name: z.literal('remove_condition'),
    args: DMToolArgsSchema.remove_condition,
  }),
  strict({
    name: z.literal('start_combat'),
    args: DMToolArgsSchema.start_combat,
  }),
  strict({ name: z.literal('end_combat'), args: DMToolArgsSchema.end_combat }),
  strict({
    name: z.literal('call_for_rest'),
    args: DMToolArgsSchema.call_for_rest,
  }),
  strict({ name: z.literal('move_to'), args: DMToolArgsSchema.move_to }),
  strict({
    name: z.literal('suggest_area_target'),
    args: DMToolArgsSchema.suggest_area_target,
  }),
  strict({ name: z.literal('grant_item'), args: DMToolArgsSchema.grant_item }),
  strict({
    name: z.literal('consume_item'),
    args: DMToolArgsSchema.consume_item,
  }),
  strict({
    name: z.literal('update_quest'),
    args: DMToolArgsSchema.update_quest,
  }),
  strict({ name: z.literal('upsert_npc'), args: DMToolArgsSchema.upsert_npc }),
  strict({
    name: z.literal('upsert_location'),
    args: DMToolArgsSchema.upsert_location,
  }),
  strict({ name: z.literal('set_flag'), args: DMToolArgsSchema.set_flag }),
  strict({
    name: z.literal('rules_lookup'),
    args: DMToolArgsSchema.rules_lookup,
  }),
  strict({ name: z.literal('log_ruling'), args: DMToolArgsSchema.log_ruling }),
]);

export const DMToolErrorCodeSchema = z.enum([
  'malformed-ref',
  'schema-violation',
  'unknown-tool',
  'missing-argument',
  'unknown-entity',
  'unknown-spell',
  'unknown-monster',
  'unknown-item',
  'unknown-skill',
  'unknown-condition',
  'unknown-quest',
  'invalid-scene-transition',
  'option-expired',
  'out-of-range',
  'no-line-of-sight',
  'unreachable',
  'insufficient-movement',
  'no-slot-available',
  'slot-level-too-low',
  'not-known',
  'not-prepared',
  'concentration-conflict',
  'not-equipped',
  'not-actors-turn',
  'incapacitated-actor',
  'restrained',
  'immune',
  'already-applied',
  'target-already-down',
  'not-in-combat',
  'already-in-combat',
  'enemies-still-active',
  'no-spawn-space',
  'area-needs-anchor',
  'illegal-transition',
  'not-in-inventory',
  'insufficient-qty',
  'condition-engine-owned',
  'loot-budget-exceeded',
  'enemy-cap-exceeded',
  'fact-immutable',
  'dc-out-of-range',
  'turn-budget-exhausted',
  'lookup-budget-exhausted',
  'scene-already-closed',
]);
export type DMToolErrorCode = z.infer<typeof DMToolErrorCodeSchema>;
export const DMToolResultSchema = z.union([
  strict({
    ok: z.literal(true),
    events: z.array(z.string()),
    summary: z.string().max(200),
    options: z
      .array(
        strict({
          optionId: z.string().regex(/^opt_[a-z0-9]{4,8}$/),
          label: z.string(),
        }),
      )
      .max(4)
      .optional(),
  }),
  strict({
    ok: z.literal(false),
    error: DMToolErrorCodeSchema,
    hint: z.string(),
    terminal: z.boolean().optional(),
  }),
]);
