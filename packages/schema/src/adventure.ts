import { z } from 'zod';
import { BattlemapSchema } from './battlemap.js';

export const AdventureNpcSeedSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  role: z.string().min(1),
  disposition: z.string().min(1),
  facts: z.array(z.string().min(1)),
});
export type AdventureNpcSeed = z.infer<typeof AdventureNpcSeedSchema>;

export const AdventureRewardSchema = z.object({
  itemId: z.string().min(1),
  quantity: z.int().positive().default(1),
});
export const AdventureQuestHookSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  description: z.string().min(1),
});
export const AdventureEncounterSchema = z.object({
  id: z.string().min(1),
  monsterIds: z.array(z.string().min(1)).min(1),
  mapId: z.string().min(1),
  partySpawnMarkerId: z.string().min(1),
  enemySpawnMarkerId: z.string().min(1),
  rewards: z.array(AdventureRewardSchema).default([]),
  questHooks: z.array(AdventureQuestHookSchema).default([]),
});
export type AdventureEncounter = z.infer<typeof AdventureEncounterSchema>;

export const AdventureSceneSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  text: z.string().min(1),
  nextSceneIds: z.array(z.string().min(1)).default([]),
  encounterIds: z.array(z.string().min(1)).default([]),
  npcIds: z.array(z.string().min(1)).default([]),
});
export type AdventureScene = z.infer<typeof AdventureSceneSchema>;

export const AdventureSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  premise: z.string().min(1),
  toneLine: z.string().min(1),
  startingSceneId: z.string().min(1),
  scenes: z.array(AdventureSceneSchema).min(1),
  npcs: z.array(AdventureNpcSeedSchema).default([]),
  encounters: z.array(AdventureEncounterSchema).default([]),
  maps: z.array(BattlemapSchema).default([]),
  monsterIds: z.array(z.string().min(1)).default([]),
  spellIds: z.array(z.string().min(1)).default([]),
  itemIds: z.array(z.string().min(1)).default([]),
});
export type Adventure = z.infer<typeof AdventureSchema>;
