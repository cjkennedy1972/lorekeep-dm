import { z } from 'zod';
import { Secret } from './llm/secret.js';
const schema = z.object({
  DATABASE_URL: z.url(),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.string().default('0.0.0.0'),
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),
  SWEEP_INTERVAL_MS: z.coerce.number().int().min(0).default(3_600_000),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.url().optional(),
  /** Trust X-Forwarded-For/Proto from the reverse proxy in front of the server. */
  TRUST_PROXY: z.stringbool().default(false),
  /** LLM provider key: env only, wrapped so it cannot be logged or serialized. */
  LLM_API_KEY: z
    .string()
    .min(1)
    .transform((v) => new Secret(v))
    .optional(),
  /** Resend API key for verification and reset email: env only, wrapped like LLM_API_KEY. */
  RESEND_API_KEY: z
    .string()
    .min(1)
    .transform((v) => new Secret(v))
    .optional(),
  EMAIL_FROM: z.string().min(1).optional(),
  /** Public web origin used to build verification and reset links, e.g. https://lorekeep.example. */
  APP_BASE_URL: z.url().optional(),
  OPERATOR_EMAILS: z.string().default(''),
  /** AES-256-GCM master key: exactly 32 bytes in hex or base64. */
  OPERATOR_ENDPOINT_MASTER_KEY: z.string().optional(),
  OPERATOR_ENDPOINT_ACTIVE_KEY_ID: z.string().optional(),
  /** Comma-separated exact hosts allowed to be local/private (e.g. a local model). */
  LLM_ALLOW_LOCAL_HOSTS: z
    .string()
    .default('')
    .transform((v) =>
      v
        .split(',')
        .map((h) => h.trim())
        .filter(Boolean),
    ),
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
