import { z } from 'zod';

export const CatalogIdSchema = z
  .string()
  .regex(
    /^(species|class|subclass|background|equipment|spell|monster|condition):[a-z0-9]+(?:-[a-z0-9]+)*$/,
    'Expected a lowercase kebab-case catalog id with a kind prefix',
  );

const base = {
  id: CatalogIdSchema,
  catalogVersion: z.string().min(1),
  srd: z.object({ source: z.literal('SRD 5.2.1'), ref: z.string().min(1) }),
  name: z.string().min(1),
};

export const AbilitySchema = z.enum(['str', 'dex', 'con', 'int', 'wis', 'cha']);
export type Ability = z.infer<typeof AbilitySchema>;

export const SpeciesEntrySchema = z.object({
  ...base,
  kind: z.literal('species'),
  size: z.enum(['tiny', 'small', 'medium', 'large']),
  speed: z.int().nonnegative(),
  conditionRefs: z.array(CatalogIdSchema).optional(),
});
export const ClassFeatureSchema = z.object({
  id: z.string().min(1),
  level: z.int().min(1).max(20),
  name: z.string().min(1),
  summary: z.string().min(1),
});
export const ClassEntrySchema = z.object({
  ...base,
  kind: z.literal('class'),
  hitDie: z.int().positive(),
  primaryAbility: z.array(AbilitySchema).min(1),
  saveProficiencies: z.array(AbilitySchema),
  armorProficiencies: z.array(z.string()).optional(),
  weaponProficiencies: z.array(z.string()).optional(),
  toolProficiencies: z.array(z.string()).optional(),
  skillChoices: z
    .object({ count: z.int().positive(), from: z.array(z.string()).min(1) })
    .optional(),
  startingEquipment: z
    .array(z.object({ option: z.string().min(1), items: z.array(z.string()) }))
    .optional(),
  features: z.array(ClassFeatureSchema).optional(),
  spellcastingAbility: AbilitySchema.optional(),
  /** Index = class level - 1; value[i] = slots of spell level i+1. */
  spellSlots: z.array(z.array(z.int().nonnegative())).optional(),
  cantripsKnown: z.array(z.int().nonnegative()).optional(),
  preparedSpells: z.array(z.int().nonnegative()).optional(),
});
export const SubclassEntrySchema = z.object({
  ...base,
  kind: z.literal('subclass'),
  classId: CatalogIdSchema,
  features: z.array(ClassFeatureSchema),
});
export const BackgroundEntrySchema = z.object({
  ...base,
  kind: z.literal('background'),
  skillProficiencies: z.array(z.string()),
  abilityOptions: z.array(AbilitySchema).optional(),
});
export const EquipmentEntrySchema = z.object({
  ...base,
  kind: z.literal('equipment'),
  category: z.enum(['weapon', 'armor', 'gear']),
  costCp: z.int().nonnegative(),
  weight: z.number().nonnegative(),
});
export const SpellEntrySchema = z.object({
  ...base,
  kind: z.literal('spell'),
  level: z.int().min(0).max(9),
  school: z.string().min(1),
  classes: z.array(z.string()),
});
export const MonsterSizeSchema = z.enum([
  'tiny',
  'small',
  'medium',
  'large',
  'huge',
  'gargantuan',
]);
/** Cells per side occupied on the 5 ft grid (Tiny uses one whole cell). */
export const SIZE_FOOTPRINT_CELLS = {
  tiny: 1,
  small: 1,
  medium: 1,
  large: 2,
  huge: 3,
  gargantuan: 4,
} as const satisfies Record<z.infer<typeof MonsterSizeSchema>, number>;

/** "NdM", "NdM+K", "NdM-K", or a flat integer ("1"). */
const DiceSchema = z.string().regex(/^\d+(?:d\d+)?(?:[+-]\d+)?$/);
export const MonsterAttackSchema = z
  .object({
    name: z.string().min(1),
    toHit: z.int(),
    reachFt: z.int().positive().optional(),
    range: z
      .object({
        normalFt: z.int().positive(),
        longFt: z.int().positive().optional(),
      })
      .optional(),
    /** damage[0] is the primary hit; later entries are SRD riders (see effect). */
    damage: z
      .array(z.object({ dice: DiceSchema, type: z.string().min(1) }))
      .min(1),
    /** SRD hit text when it has more than plain damage. */
    effect: z.string().min(1).optional(),
    /** SRD parenthetical on the to-hit, e.g. "with Advantage if ...". */
    toHitNote: z.string().min(1).optional(),
  })
  .refine((a) => a.reachFt !== undefined || a.range !== undefined, {
    message: 'Attack needs a reach or a range band',
  });
export const MonsterTraitSchema = z.object({
  name: z.string().min(1),
  kind: z.enum(['trait', 'action', 'bonus-action', 'reaction']),
  text: z.string().min(1),
});
export const MonsterEntrySchema = z
  .object({
    ...base,
    kind: z.literal('monster'),
    cr: z.number().nonnegative(),
    creatureType: z.string().min(1).optional(),
    hp: z.int().positive(),
    hpDice: DiceSchema.optional(),
    ac: z.int().positive(),
    initiative: z.int().optional(),
    /** Walking speed in ft. */
    speed: z.int().nonnegative(),
    otherSpeeds: z
      .object({
        burrow: z.int().positive().optional(),
        climb: z.int().positive().optional(),
        fly: z.int().positive().optional(),
        swim: z.int().positive().optional(),
      })
      .optional(),
    size: MonsterSizeSchema,
    footprint: z.int().min(1).max(4).optional(),
    abilities: z.record(AbilitySchema, z.int().min(1).max(30)).optional(),
    saves: z.partialRecord(AbilitySchema, z.int()).optional(),
    skills: z.record(z.string(), z.int()).optional(),
    damageResistances: z.array(z.string()).optional(),
    damageVulnerabilities: z.array(z.string()).optional(),
    damageImmunities: z.array(z.string()).optional(),
    conditionImmunities: z.array(z.string()).optional(),
    senses: z.record(z.string(), z.int().positive()).optional(),
    passivePerception: z.int().optional(),
    attacks: z.array(MonsterAttackSchema).optional(),
    traits: z.array(MonsterTraitSchema).optional(),
  })
  .refine(
    (m) =>
      m.footprint === undefined || m.footprint === SIZE_FOOTPRINT_CELLS[m.size],
    {
      path: ['footprint'],
      message: 'Footprint must match the size category',
    },
  );
export const ConditionEntrySchema = z.object({
  ...base,
  kind: z.literal('condition'),
  description: z.string().min(1),
});

export const CatalogEntrySchema = z
  .discriminatedUnion('kind', [
    SpeciesEntrySchema,
    ClassEntrySchema,
    SubclassEntrySchema,
    BackgroundEntrySchema,
    EquipmentEntrySchema,
    SpellEntrySchema,
    MonsterEntrySchema,
    ConditionEntrySchema,
  ])
  .refine((entry) => entry.id.startsWith(`${entry.kind}:`), {
    path: ['id'],
    message: 'Catalog id prefix must match entry kind',
  });
export type CatalogEntry = z.infer<typeof CatalogEntrySchema>;
export type CatalogKind = CatalogEntry['kind'];
