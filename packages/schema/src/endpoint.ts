import { z } from 'zod';
export const EndpointProfileSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    provider: z.string().min(1),
    model: z.string().min(1),
    baseUrl: z.url().optional(),
  })
  .strict();
// Client-safe config deliberately has no credential/key material; H1-H5 defaults remain pending human decisions.
export const EndpointConfigSchema = z
  .object({
    profileId: z.string().min(1),
    toolMode: z.enum([
      'native',
      'json-schema',
      'json-in-text',
      'engine-assist',
    ]),
    temperature: z.number().min(0).max(2).optional(),
    maxTokens: z.int().positive().optional(),
  })
  .strict();
export const UsageEntrySchema = z
  .object({
    sessionId: z.string().uuid(),
    turnId: z.string().min(1),
    purpose: z.enum(['narration', 'summary', 'classification', 'moderation']),
    modelId: z.string().min(1),
    inputTokens: z.int().nonnegative(),
    outputTokens: z.int().nonnegative(),
    cacheReadTokens: z.int().nonnegative().optional(),
    estimated: z.boolean(),
    latencyMs: z.int().nonnegative(),
    retries: z.int().nonnegative(),
    errorCode: z.string().nullable(),
    costMicros: z.int().nonnegative().optional(),
  })
  .strict();
export type EndpointProfile = z.infer<typeof EndpointProfileSchema>;
export type EndpointConfig = z.infer<typeof EndpointConfigSchema>;
export type UsageEntry = z.infer<typeof UsageEntrySchema>;
