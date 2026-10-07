import { z } from 'zod';

export const CatalogIdSchema = z.string().min(1);

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
});
export const ClassEntrySchema = z.object({
  ...base,
  kind: z.literal('class'),
  hitDie: z.int().positive(),
  primaryAbility: z.array(AbilitySchema).min(1),
  saveProficiencies: z.array(AbilitySchema),
});
export const BackgroundEntrySchema = z.object({
  ...base,
  kind: z.literal('background'),
  skillProficiencies: z.array(z.string()),
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

export const CatalogEntrySchema = z.discriminatedUnion('kind', [
  SpeciesEntrySchema,
  ClassEntrySchema,
  BackgroundEntrySchema,
  EquipmentEntrySchema,
  SpellEntrySchema,
  MonsterEntrySchema,
  ConditionEntrySchema,
]);
export type CatalogEntry = z.infer<typeof CatalogEntrySchema>;
export type CatalogKind = CatalogEntry['kind'];
