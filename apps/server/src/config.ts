import { isIP } from 'node:net';
import { z } from 'zod';
import { Secret } from './llm/secret.js';

const isTrustedAddress = (entry: string) => {
  const [address, prefix, extra] = entry.split('/');
  if (extra !== undefined || !address || !isIP(address)) return false;
  if (prefix === undefined) return true;
  return (
    /^\d+$/.test(prefix) && Number(prefix) <= (isIP(address) === 6 ? 128 : 32)
  );
};

/** true/false, a hop count (0 means false), or a comma-separated list of trusted proxy IPs or CIDRs. */
export function parseTrustProxy(raw: string): boolean | number | string[] {
  const value = raw.trim().toLowerCase();
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^\d+$/.test(value)) return Number(value) === 0 ? false : Number(value);
  const entries = value.split(',').map((entry) => entry.trim());
  if (entries.every(isTrustedAddress)) return entries;
  throw new Error(`invalid TRUST_PROXY: ${raw}`);
}

const schema = z.object({
  DATABASE_URL: z.url(),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.string().default('0.0.0.0'),
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    // ponytail: unset means production so the operator and email boot checks fail closed; dev/test opt in.
    .default('production'),
  SWEEP_INTERVAL_MS: z.coerce.number().int().min(0).default(3_600_000),
  ROOM_DRAIN_DEADLINE_MS: z.coerce.number().int().min(0).default(30_000),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.url().optional(),
  /** Trust X-Forwarded-For/Proto from the reverse proxy: true, a hop count, or trusted proxy CIDRs. */
  TRUST_PROXY: z.string().default('false').transform(parseTrustProxy),
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
