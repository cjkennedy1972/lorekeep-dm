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
export const MonsterEntrySchema = z.object({
  ...base,
  kind: z.literal('monster'),
  cr: z.number().nonnegative(),
  hp: z.int().positive(),
  ac: z.int().positive(),
  speed: z.int().nonnegative(),
  size: z.enum(['tiny', 'small', 'medium', 'large', 'huge', 'gargantuan']),
});
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
