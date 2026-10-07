import { z } from 'zod';
import { AbilitySchema, CatalogIdSchema } from './catalog.js';

export const ConditionInstanceSchema = z.object({
  conditionId: CatalogIdSchema,
  source: z.string().optional(),
  duration: z.int().positive().optional(),
});
export type ConditionInstance = z.infer<typeof ConditionInstanceSchema>;

export const CharacterSchema = z.object({
  id: z.uuid(),
  name: z.string().min(1),
  speciesId: CatalogIdSchema,
  classId: CatalogIdSchema,
  backgroundId: CatalogIdSchema,
  level: z.int().min(1).max(20),
  abilities: z.record(AbilitySchema, z.int().min(1).max(30)),
  proficiencies: z.object({
    skills: z.array(z.string()),
    saves: z.array(AbilitySchema),
    tools: z.array(z.string()),
  }),
  equipment: z.array(
    z.object({
      itemId: CatalogIdSchema,
      qty: z.int().positive(),
      equipped: z.boolean(),
    }),
  ),
  spellsKnown: z.array(CatalogIdSchema),
  spellsPrepared: z.array(CatalogIdSchema),
  // spell slots by spell level (1-9)
  slots: z.record(
    z.string().regex(/^[1-9]$/),
    z.object({ max: z.int().nonnegative(), used: z.int().nonnegative() }),
  ),
  hp: z.object({
    current: z.int(),
    max: z.int().positive(),
    temp: z.int().nonnegative(),
  }),
  conditions: z.array(ConditionInstanceSchema),
});
export type Character = z.infer<typeof CharacterSchema>;
