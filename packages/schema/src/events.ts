import { z } from 'zod';
import { SessionIdSchema, TurnIdSchema } from './ids.js';

export const EventRowSchema = z.object({
  sessionId: SessionIdSchema,
  seq: z.int().positive(),
  turnId: TurnIdSchema,
  type: z.string().min(1),
  payload: z.record(z.string(), z.unknown()),
  ts: z.iso.datetime(),
});
export type EventRow = z.infer<typeof EventRowSchema>;
