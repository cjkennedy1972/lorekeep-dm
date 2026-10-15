import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { ENDPOINT_SLOTS, type EndpointSlot } from './config.js';

type Queryable = Pick<Pool, 'query'>;

interface MatureProbeFacts {
  id?: unknown;
  model?: unknown;
  toolMode?: unknown;
  capabilities?: {
    reachability?: { supported?: unknown };
    streaming?: { supported?: unknown };
    nativeTools?: { supported?: unknown };
    jsonSchema?: { supported?: unknown };
  };
}

/**
 * A technical-use gate only. Both roles must be reachable and streaming; only
 * narration requires structured tool calls. The selected mode's supported flag
 * already encodes its own 95% validity threshold; aggregate validCallRate is not
 * a gate. This does not infer or attest that endpoint terms permit mature content.
 */
export function hasMatureEndpointTechnicalSupport(
  probe: MatureProbeFacts | null | undefined,
  slot: EndpointSlot,
  model: string,
  role: 'narration' | 'moderation' = 'narration',
): boolean {
  const supportedToolMode =
    (probe?.toolMode === 'native' &&
      probe.capabilities?.nativeTools?.supported === true) ||
    (probe?.toolMode === 'json-schema' &&
      probe.capabilities?.jsonSchema?.supported === true);
  return (
    probe?.id === slot &&
    probe.model === model &&
    probe.capabilities?.reachability?.supported === true &&
    probe.capabilities?.streaming?.supported === true &&
    (role === 'moderation' || supportedToolMode)
  );
}

export function configuredSoloEndpointSlot(): EndpointSlot {
  const slot = process.env.SOLO_TURN_ENDPOINT_SLOT ?? 'fast';
  if (!ENDPOINT_SLOTS.includes(slot as EndpointSlot))
    throw new Error('Solo turn endpoint slot is invalid');
  return slot as EndpointSlot;
}

interface MatureEndpoint {
  fingerprint: string;
}

export interface MatureEndpointGrant {
  narrationFingerprint: string;
  moderationFingerprint: string;
}

/** Fingerprint is intentionally non-secret and changes whenever config is saved. */
export async function verifiedMatureEndpoint(
  db: Queryable,
  slot: EndpointSlot,
  role: 'narration' | 'moderation',
): Promise<MatureEndpoint | null> {
  const { rows } = await db.query<{
    base_url: string;
    model: string;
    api_style: string;
    key_fingerprint: string | null;
    updated_at: Date | string;
    probe: MatureProbeFacts | null;
  }>(
    'SELECT base_url,model,api_style,key_fingerprint,updated_at,probe FROM operator_endpoints WHERE slot=$1',
    [slot],
  );
  const endpoint = rows[0];
  const probe = endpoint?.probe;
  if (
    !endpoint ||
    !hasMatureEndpointTechnicalSupport(probe, slot, endpoint.model, role)
  )
    return null;
  const updatedAt = new Date(endpoint.updated_at).toISOString();
  const fingerprint = createHash('sha256')
    .update(
      JSON.stringify([
        slot,
        endpoint.base_url,
        endpoint.model,
        endpoint.api_style,
        endpoint.key_fingerprint,
        updatedAt,
      ]),
    )
    .digest('hex');
  return { fingerprint };
}

/** True only when the session grant matches both currently configured endpoints. */
export async function sessionMatureEndpointAllowed(
  db: Queryable,
  sessionId: string,
  slot: EndpointSlot = configuredSoloEndpointSlot(),
): Promise<boolean> {
  const { rows } = await db.query<{
    endpoint_allows_mature: boolean;
    endpoint_mature_fingerprint: string | null;
    moderation_mature_fingerprint: string | null;
  }>(
    'SELECT endpoint_allows_mature,endpoint_mature_fingerprint,moderation_mature_fingerprint FROM sessions WHERE id=$1',
    [sessionId],
  );
  const session = rows[0];
  if (
    !session?.endpoint_allows_mature ||
    !session.endpoint_mature_fingerprint ||
    !session.moderation_mature_fingerprint
  )
    return false;
  const [narration, moderation] = await Promise.all([
    verifiedMatureEndpoint(db, slot, 'narration'),
    verifiedMatureEndpoint(db, 'moderate', 'moderation'),
  ]);
  return (
    narration?.fingerprint === session.endpoint_mature_fingerprint &&
    moderation?.fingerprint === session.moderation_mature_fingerprint
  );
}

export async function verifiedMatureEndpointGrant(
  db: Queryable,
  narrationSlot: EndpointSlot,
): Promise<MatureEndpointGrant | null> {
  const [narration, moderation] = await Promise.all([
    verifiedMatureEndpoint(db, narrationSlot, 'narration'),
    verifiedMatureEndpoint(db, 'moderate', 'moderation'),
  ]);
  if (!narration || !moderation) return null;
  return {
    narrationFingerprint: narration.fingerprint,
    moderationFingerprint: moderation.fingerprint,
  };
}
