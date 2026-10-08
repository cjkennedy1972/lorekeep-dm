import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto';
import type { Pool } from 'pg';
import { z } from 'zod';
import { createEgressGuard, type EgressGuard } from './egress.js';
import { AnthropicMessagesAdapter } from './dialects/anthropic.js';
import { OpenAICompatibleAdapter } from './dialects/openai.js';
import { Secret } from './secret.js';
import { probeEndpoint, type EndpointProfile } from './probe.js';

export const ENDPOINT_SLOTS = ['fast', 'frontier', 'moderate'] as const;
export type EndpointSlot = (typeof ENDPOINT_SLOTS)[number];
export type ApiStyle = 'openai' | 'anthropic';
const inputSchema = z
  .object({
    baseUrl: z.string().min(1).max(2048),
    model: z.string().trim().min(1).max(200),
    apiStyle: z.enum(['openai', 'anthropic']),
    apiKey: z.string().max(4096).optional(),
    contextWindow: z.number().int().positive().optional(),
  })
  .strict();
export type EndpointInput = z.infer<typeof inputSchema>;
export interface EndpointConfig {
  slot: EndpointSlot;
  baseUrl: string;
  model: string;
  apiStyle: ApiStyle;
  contextWindow?: number;
  keySet: boolean;
  keyFingerprint: string | null;
  updatedAt: string;
  probe: EndpointProfile | null;
}
const envelopeVersion = 'v1';
function masterKey(raw = process.env.OPERATOR_ENDPOINT_MASTER_KEY): {
  id: string;
  key: Buffer;
} {
  if (!raw && process.env.NODE_ENV === 'production')
    throw new Error('Endpoint encryption key unavailable');
  if (!raw)
    return {
      id: 'dev',
      key: createHash('sha256')
        .update('lorekeep-development-endpoint-key')
        .digest(),
    };
  const keys = raw.split(',').map((entry) => {
    const [id, encoded] = entry.includes(':')
      ? entry.split(':', 2)
      : ['primary', entry];
    if (!id || !encoded) throw new Error('Endpoint encryption key unavailable');
    let key: Buffer;
    if (/^[0-9a-f]{64}$/i.test(encoded)) key = Buffer.from(encoded, 'hex');
    else key = Buffer.from(encoded, 'base64');
    if (key.length !== 32 || !/^[a-zA-Z0-9_-]{1,32}$/.test(id))
      throw new Error('Endpoint encryption key unavailable');
    return { id, key };
  });
  const activeId = process.env.OPERATOR_ENDPOINT_ACTIVE_KEY_ID;
  const active = activeId
    ? keys.find((item) => item.id === activeId)
    : keys.at(-1);
  if (!active) throw new Error('Endpoint encryption key unavailable');
  return active;
}
export function encryptEndpointKey(
  value: string,
  rawMasterKey?: string,
): string {
  const { id, key } = masterKey(rawMasterKey);
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(`${envelopeVersion}.${id}`));
  const ciphertext = Buffer.concat([
    cipher.update(value, 'utf8'),
    cipher.final(),
  ]);
  return [
    envelopeVersion,
    id,
    nonce.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
    ciphertext.toString('base64url'),
  ].join('.');
}
export function decryptEndpointKey(
  envelope: string,
  rawMasterKey?: string,
): string {
  try {
    const [version, id, nonceText, tagText, cipherText, ...extra] =
      envelope.split('.');
    if (
      version !== envelopeVersion ||
      !id ||
      !nonceText ||
      !tagText ||
      !cipherText ||
      extra.length
    )
      throw new Error();
    const keys = (
      rawMasterKey ??
      process.env.OPERATOR_ENDPOINT_MASTER_KEY ??
      'lorekeep-development-endpoint-key'
    )
      .split(',')
      .map((entry) => {
        const [keyId, encoded] = entry.includes(':')
          ? entry.split(':', 2)
          : [
              rawMasterKey || process.env.OPERATOR_ENDPOINT_MASTER_KEY
                ? 'primary'
                : 'dev',
              entry,
            ];
        if (
          keyId === 'dev' &&
          !rawMasterKey &&
          !process.env.OPERATOR_ENDPOINT_MASTER_KEY
        )
          return {
            id: keyId,
            key: createHash('sha256')
              .update(encoded ?? '')
              .digest(),
          };
        return {
          id: keyId,
          key: /^[0-9a-f]{64}$/i.test(encoded ?? '')
            ? Buffer.from(encoded!, 'hex')
            : Buffer.from(encoded ?? '', 'base64'),
        };
      });
    const selected = keys.find((item) => item.id === id);
    if (!selected || selected.key.length !== 32) throw new Error();
    const decipher = createDecipheriv(
      'aes-256-gcm',
      selected.key,
      Buffer.from(nonceText, 'base64url'),
    );
    decipher.setAAD(Buffer.from(`${version}.${id}`));
    decipher.setAuthTag(Buffer.from(tagText, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(cipherText, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    throw new Error('Endpoint credential unavailable');
  }
}
export async function isOperatorAccount(
  db: Pick<Pool, 'query'>,
  accountId: string,
  allowlist = process.env.OPERATOR_EMAILS ?? '',
): Promise<boolean> {
  const emails = allowlist
    .split(',')
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);
  if (!emails.length) return false;
  const result = await db.query(
    "SELECT email FROM accounts WHERE id=$1 AND status='active'",
    [accountId],
  );
  return result.rows.some((row) =>
    emails.includes(String(row.email).toLowerCase()),
  );
}
export async function validateEndpointUrl(
  baseUrl: string,
  egress: EgressGuard,
): Promise<void> {
  try {
    const url = new URL(baseUrl);
    if (
      !['https:', 'http:'].includes(url.protocol) ||
      url.username ||
      url.password
    )
      throw new Error();
    if (
      url.protocol === 'http:' &&
      !(process.env.LLM_ALLOW_LOCAL_HOSTS ?? '')
        .split(',')
        .map((v) => v.trim().toLowerCase())
        .includes(url.hostname.toLowerCase())
    )
      throw new Error();
    await egress.validate(baseUrl);
  } catch {
    throw new Error('Endpoint URL is not allowed');
  }
}
export async function saveEndpoint(
  db: Pool,
  slot: EndpointSlot,
  raw: unknown,
  egress: EgressGuard,
  master?: string,
): Promise<EndpointConfig> {
  const config = inputSchema.parse(raw);
  await validateEndpointUrl(config.baseUrl, egress);
  const prior = await db.query(
    'SELECT encrypted_key FROM operator_endpoints WHERE slot=$1',
    [slot],
  );
  const keyValue =
    config.apiKey === undefined
      ? prior.rows[0]?.encrypted_key
        ? decryptEndpointKey(String(prior.rows[0].encrypted_key), master)
        : ''
      : config.apiKey;
  const encrypted = keyValue ? encryptEndpointKey(keyValue, master) : null;
  const fingerprint = keyValue
    ? createHash('sha256').update(keyValue).digest('hex').slice(0, 12)
    : null;
  const result = await db.query(
    `INSERT INTO operator_endpoints(slot,base_url,model,api_style,encrypted_key,key_fingerprint,context_window,probe,updated_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,NULL,now()) ON CONFLICT(slot) DO UPDATE SET base_url=EXCLUDED.base_url,model=EXCLUDED.model,api_style=EXCLUDED.api_style,encrypted_key=EXCLUDED.encrypted_key,key_fingerprint=EXCLUDED.key_fingerprint,context_window=EXCLUDED.context_window,probe=NULL,updated_at=now() RETURNING slot,base_url,model,api_style,key_fingerprint,context_window,updated_at`,
    [
      slot,
      config.baseUrl,
      config.model,
      config.apiStyle,
      encrypted,
      fingerprint,
      config.contextWindow ?? null,
    ],
  );
  await db.query(
    'INSERT INTO operator_endpoint_audit(slot,action) VALUES($1,$2)',
    [slot, prior.rowCount ? 'updated' : 'created'],
  );
  return {
    ...rowConfig(result.rows[0]!, null),
    keySet: Boolean(encrypted),
    keyFingerprint: fingerprint,
  };
}
export async function testEndpoint(
  db: Pool,
  slot: EndpointSlot,
  egress: EgressGuard,
  master?: string,
): Promise<EndpointProfile> {
  const result = await db.query(
    'SELECT base_url,model,api_style,encrypted_key,context_window FROM operator_endpoints WHERE slot=$1',
    [slot],
  );
  const row = result.rows[0];
  if (!row) throw new Error('Endpoint configuration unavailable');
  const apiKey = row.encrypted_key
    ? new Secret(decryptEndpointKey(String(row.encrypted_key), master))
    : undefined;
  const adapter =
    row.api_style === 'anthropic'
      ? new AnthropicMessagesAdapter({
          baseUrl: String(row.base_url),
          model: String(row.model),
          apiKey,
          egress,
        })
      : new OpenAICompatibleAdapter({
          baseUrl: String(row.base_url),
          model: String(row.model),
          apiKey,
          egress,
        });
  const probe = await probeEndpoint(adapter, {
    id: slot,
    model: String(row.model),
    contextWindow:
      row.context_window === null ? undefined : Number(row.context_window),
  });
  await db.query(
    'UPDATE operator_endpoints SET probe=$2::jsonb WHERE slot=$1',
    [slot, JSON.stringify(probe)],
  );
  return probe;
}
function rowConfig(
  row: Record<string, unknown>,
  probe: EndpointProfile | null,
): EndpointConfig {
  return {
    slot: row.slot as EndpointSlot,
    baseUrl: String(row.base_url),
    model: String(row.model),
    apiStyle: row.api_style as ApiStyle,
    contextWindow:
      row.context_window === null ? undefined : Number(row.context_window),
    keySet: Boolean(row.key_fingerprint),
    keyFingerprint: row.key_fingerprint ? String(row.key_fingerprint) : null,
    updatedAt: new Date(String(row.updated_at)).toISOString(),
    probe,
  };
}
export async function readEndpoints(db: Pool): Promise<EndpointConfig[]> {
  const result = await db.query(
    'SELECT slot,base_url,model,api_style,key_fingerprint,context_window,probe,updated_at FROM operator_endpoints ORDER BY slot',
  );
  return result.rows.map((row) =>
    rowConfig(row, row.probe as EndpointProfile | null),
  );
}
export function createEndpointEgress(): EgressGuard {
  return createEgressGuard({
    allowLocalHosts: (process.env.LLM_ALLOW_LOCAL_HOSTS ?? '')
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean),
  });
}
