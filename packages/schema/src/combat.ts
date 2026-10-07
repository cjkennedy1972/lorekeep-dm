import { z } from 'zod';

export const GridPosSchema = z.object({ x: z.int(), y: z.int() });
export type GridPos = z.infer<typeof GridPosSchema>;

export const TurnResourcesSchema = z.object({
  action: z.boolean(),
  bonusAction: z.boolean(),
  reaction: z.boolean(),
  movementLeft: z.int().nonnegative(),
});
export type TurnResources = z.infer<typeof TurnResourcesSchema>;

export const CombatEntitySchema = z.object({
  id: z.string().min(1),
  kind: z.enum(['character', 'monster', 'npc']),
  pos: GridPosSchema,
  size: z.int().positive(), // footprint in cells per side
  hp: z.int(),
});
export type CombatEntity = z.infer<typeof CombatEntitySchema>;

export const CombatStateSchema = z.object({
  round: z.int().positive(),
  turnIndex: z.int().nonnegative(),
  initiative: z.array(
    z.object({ entityId: z.string().min(1), total: z.int() }),
  ),
  resources: z.record(z.string(), TurnResourcesSchema),
  entities: z.array(CombatEntitySchema),
});
export type CombatState = z.infer<typeof CombatStateSchema>;
