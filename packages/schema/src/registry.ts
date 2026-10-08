import { z } from 'zod';
const ref = (prefix: string) =>
  z.string().regex(new RegExp(`^${prefix}_[a-z0-9_-]{1,32}$`));
const facts = z.array(z.string().max(160)).max(8);
export const NpcSchema = z
  .object({
    id: ref('npc'),
    name: z.string().min(2).max(60),
    role: z.string().max(60),
    disposition: z.enum([
      'hostile',
      'unfriendly',
      'neutral',
      'friendly',
      'ally',
    ]),
    facts,
  })
  .strict();
export const LocationSchema = z
  .object({
    id: ref('loc'),
    name: z.string().min(2).max(60),
    role: z.string().max(60),
    facts,
  })
  .strict();
export const QuestSchema = z
  .object({
    id: ref('quest'),
    status: z.enum(['available', 'active', 'completed', 'failed']),
    note: z.string().max(240).optional(),
  })
  .strict();
export const FlagSchema = z
  .object({
    id: ref('flag'),
    value: z.union([z.boolean(), z.string().max(64), z.int()]),
  })
  .strict();
export const RulingSchema = z
  .object({
    id: ref('ruling'),
    topic: z.string().max(80),
    ruling: z.string().max(400),
  })
  .strict();
export const SceneSummarySchema = z
  .object({
    sceneId: z.string().min(1),
    summary: z.string().max(1200),
    createdAt: z.iso.datetime(),
  })
  .strict();
