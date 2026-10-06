import { z } from 'zod';
const schema = z.object({
  DATABASE_URL: z.url(),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.string().default('0.0.0.0'),
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),
  SWEEP_INTERVAL_MS: z.coerce.number().int().min(0).default(3_600_000),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.url().optional(),
});
export type ServerConfig = z.infer<typeof schema>;
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const result = schema.safeParse(env);
  if (!result.success)
    throw new Error(
      `Invalid server environment: ${result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
    );
  return result.data;
}
