import {
  FlagSchema,
  LocationSchema,
  NpcSchema,
  QuestSchema,
  RulingSchema,
} from '@game/schema';
import type { Pool, PoolClient } from 'pg';
import {
  identityPartPattern,
  identityParts,
  isCommonWordNamePart,
  identityRewritePatterns,
  mentionsIdentity,
} from './identityMatcher.js';
import { containsForbiddenWordRun } from './textScreening.js';
import {
  ensureSessionCharacterToken,
  indexDerivedMemoryRow,
  lockSessionForDerivedMemoryWrite,
} from './characterReferences.js';

export const MAX_MEMORY_RESULTS = 20;
export const MAX_MEMORY_CHARS = 4_000;
export const MAX_ENTITY_FACTS = 40;
export const MAX_SCENE_SUMMARY_CHARS = 1_200;
const REGISTRY_SEARCH_DOCUMENT_SQL = `concat_ws(' ', e.name, array_to_string(e.aliases, ' '), (e.payload - 'facts')::text, (SELECT string_agg(f.fact, ' ') FROM registry_facts f WHERE f.entry_id=e.id AND f.superseded_by IS NULL))`;

export type RegistryEntity = {
  entityId: string;
  name: string;
  aliases: string[];
  facts: string[];
  mentionedAt: number;
};
export type RegistryFact = {
  entityId: string;
  text: string;
  mentionedAt: number;
};
export type RegistryDiff =
  | {
      kind: 'npc';
      id: string;
      after: Record<string, unknown>;
      aliases?: string[];
      supersedesFacts?: Record<string, string>;
    }
  | {
      kind: 'location';
      id: string;
      after: Record<string, unknown>;
      aliases?: string[];
      supersedesFacts?: Record<string, string>;
    }
  | {
      kind: 'quest' | 'flag' | 'ruling';
      id: string;
      after: Record<string, unknown>;
    };

type Pg = Pick<Pool, 'query' | 'connect'>;
export class DerivedMemoryLeaseLostError extends Error {
  constructor() {
    super('Session lease changed during derived-memory generation');
    this.name = 'DerivedMemoryLeaseLostError';
  }
}

export type RegistryPrivacyOptions = {
  /** Locally held player utterances; never included in registry data or logs. */
  forbiddenPlayerText?: readonly string[];
};
export type RegistryEvent =
  | { type: 'NpcUpserted'; npc: Record<string, unknown> & { id: string } }
  | {
      type: 'LocationUpserted';
      location: Record<string, unknown> & { id: string };
    }
  | { type: 'QuestUpdated'; quest: Record<string, unknown> & { id: string } }
  | { type: 'FlagSet'; flag: Record<string, unknown> & { id: string } }
  | { type: 'RulingLogged'; ruling: Record<string, unknown> & { id: string } };
type EntryRow = {
  id: string;
  version: number;
  payload: Record<string, unknown>;
  name: string;
  aliases: string[];
  mentioned_at: string;
};

function entityName(kind: string, payload: Record<string, unknown>): string {
  if (kind === 'npc' || kind === 'location') return String(payload.name ?? '');
  if (kind === 'ruling') return String(payload.topic ?? '');
  return String(payload.id ?? '');
}
function validatePayload(
  kind: RegistryDiff['kind'],
  id: string,
  payload: Record<string, unknown>,
  aliases: string[] = [],
): Record<string, unknown> {
  const schema =
    kind === 'npc'
      ? NpcSchema
      : kind === 'location'
        ? LocationSchema
        : kind === 'quest'
          ? QuestSchema
          : kind === 'flag'
            ? FlagSchema
            : RulingSchema;
  const parsed = schema.parse(payload) as Record<string, unknown>;
  if (parsed.id !== id)
    throw new Error('Registry entity id does not match its payload');
  if (
    aliases.length > 16 ||
    aliases.some((alias) => alias.trim().length < 2 || alias.length > 60)
  )
    throw new Error(
      'Registry aliases must contain 2 to 60 characters, with at most 16 aliases',
    );
  return parsed;
}
function factsFrom(payload: Record<string, unknown>): string[] {
  return Array.isArray(payload.facts)
    ? payload.facts.filter((fact): fact is string => typeof fact === 'string')
    : [];
}
function normalize(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** Pure deterministic mention matching. Inputs are treated as quoted data, never instructions. */
export function extractMentionedRegistryFacts(
  text: string,
  entities: readonly RegistryEntity[],
): RegistryFact[] {
  const haystack = ` ${normalize(text)} `;
  return entities
    .map((entity) => {
      const positions = [entity.name, ...entity.aliases]
        .map((label) => normalize(label))
        .filter((label) => label.length > 0)
        .map((label) => haystack.lastIndexOf(` ${label} `))
        .filter((position) => position >= 0);
      return { entity, position: Math.max(-1, ...positions) };
    })
    .filter(({ position }) => position >= 0)
    .sort(
      (a, b) =>
        b.position - a.position ||
        a.entity.entityId.localeCompare(b.entity.entityId),
    )
    .flatMap(({ entity, position }) =>
      entity.facts.map((fact) => ({
        entityId: entity.entityId,
        text: fact,
        mentionedAt: position,
      })),
    );
}

const PRIVACY_CONFUSABLES: Readonly<Record<string, string>> = {
  а: 'a',
  е: 'e',
  о: 'o',
  р: 'p',
  с: 'c',
  у: 'y',
  х: 'x',
  і: 'i',
  ј: 'j',
  к: 'k',
  м: 'm',
  т: 't',
  в: 'b',
  н: 'h',
  ԁ: 'd',
  ԛ: 'q',
  ӏ: 'l',
  α: 'a',
  β: 'b',
  ε: 'e',
  ι: 'i',
  κ: 'k',
  ο: 'o',
  ρ: 'p',
  τ: 't',
  υ: 'y',
  χ: 'x',
  ν: 'v',
  μ: 'm',
  η: 'n',
};
const foldPrivacyText = (text: string) =>
  text
    .normalize('NFKC')
    .replace(/\p{Cf}/gu, '')
    .toLocaleLowerCase('und')
    .replace(/ß/g, 'ss')
    .replace(/ς/g, 'σ')
    .replace(
      /[а-ео-сухіјкмтвнԁԛӏαβε ικορτυχνμη]/gu,
      (char) => PRIVACY_CONFUSABLES[char] ?? char,
    );

function containsRegistryIdentity(
  text: string,
  identities: readonly string[],
): boolean {
  return identities.some((identity) => {
    let probe = text;
    for (const part of identityParts(identity)) {
      if (
        isCommonWordNamePart(part) &&
        part === part.toLocaleLowerCase('und')
      ) {
        probe = probe.replace(identityPartPattern(part), ' ');
        continue;
      }
      const insensitive = identityPartPattern(part);
      const sensitive = identityPartPattern(part, true);
      insensitive.lastIndex = 0;
      sensitive.lastIndex = 0;
      if (insensitive.test(text) && !sensitive.test(text))
        probe = probe.replace(identityPartPattern(part), ' ');
    }
    return mentionsIdentity(probe, identity, foldPrivacyText(probe));
  });
}

type RegistryIdentityContext = {
  tokenByCharacter: Map<string, string>;
  tokenByIdentity: Map<string, string | null>;
};

async function loadRegistryIdentityContext(
  client: PoolClient,
  sessionId: string,
): Promise<RegistryIdentityContext> {
  const identityRows = await client.query<{
    display_name: string | null;
    email: string | null;
    character_snapshot: unknown;
    character_id: string | null;
    binding_status: string;
    token: string | null;
    character: unknown;
  }>(
    `SELECT a.display_name,a.email,b.character_snapshot,b.character_id,b.binding_status,
            t.token,c.character
       FROM session_seat_characters b
       LEFT JOIN accounts a ON a.id=b.account_id
       LEFT JOIN session_character_tokens t ON t.session_id=b.session_id AND t.character_id=b.character_id
       LEFT JOIN account_characters c ON c.id=b.character_id
      WHERE b.session_id=$1`,
    [sessionId],
  );
  const tokenByCharacter = new Map<string, string>();
  const tokenByIdentity = new Map<string, string | null>();
  for (const row of identityRows.rows) {
    let token: string | null = null;
    if (row.character_id) {
      token = row.token;
      if (!token && row.binding_status === 'active') {
        token = await ensureSessionCharacterToken(
          client,
          sessionId,
          row.character_id,
        );
      }
      if (token) tokenByCharacter.set(row.character_id, token);
    }
    const snapshot =
      row.character_snapshot && typeof row.character_snapshot === 'object'
        ? (row.character_snapshot as Record<string, unknown>)
        : {};
    const identities = [
      row.display_name,
      row.email,
      snapshot.name,
      ...(Array.isArray(snapshot.aliases) ? snapshot.aliases : []),
      ...(() => {
        const profile =
          row.character && typeof row.character === 'object'
            ? (row.character as Record<string, unknown>)
            : {};
        return [
          profile.name,
          ...(Array.isArray(profile.aliases) ? profile.aliases : []),
        ];
      })(),
    ].filter(
      (value): value is string => typeof value === 'string' && !!value.trim(),
    );
    for (const identity of identities) {
      const prior = tokenByIdentity.get(identity);
      if (prior !== undefined && prior !== token)
        throw new Error(
          'Ambiguous character identity; refusing registry write',
        );
      tokenByIdentity.set(identity, token);
    }
  }
  return { tokenByCharacter, tokenByIdentity };
}

function screenRegistryText(
  text: string,
  context: RegistryIdentityContext,
  privacy: RegistryPrivacyOptions,
): string {
  const folded = foldPrivacyText(text);
  const quotes = (privacy.forbiddenPlayerText ?? [])
    .map(foldPrivacyText)
    .filter(Boolean);
  if (
    quotes.some((quote) => folded.includes(quote)) ||
    containsForbiddenWordRun(text, privacy.forbiddenPlayerText ?? [])
  )
    throw new Error(
      'Registry payload contains quoted player text; refusing write',
    );
  let replaced = text;
  for (const [identity, token] of [...context.tokenByIdentity].sort(
    ([a], [b]) => b.length - a.length,
  )) {
    if (!identity.trim()) continue;
    const matchers = identityRewritePatterns(identity);
    const matches = matchers.some((matcher) => {
      matcher.lastIndex = 0;
      return matcher.test(replaced);
    });
    if (!matches) continue;
    if (!token)
      throw new Error('Unbound character identity; refusing registry write');
    for (const matcher of matchers) {
      matcher.lastIndex = 0;
      replaced = replaced.replace(matcher, token);
    }
  }
  if (containsRegistryIdentity(replaced, [...context.tokenByIdentity.keys()]))
    throw new Error(
      'Registry payload contains an unscreened character identity',
    );
  return replaced;
}

function screenRegistryValue(
  value: unknown,
  context: RegistryIdentityContext,
  privacy: RegistryPrivacyOptions,
): unknown {
  if (typeof value === 'string')
    return screenRegistryText(value, context, privacy);
  if (Array.isArray(value))
    return value.map((item) => screenRegistryValue(item, context, privacy));
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        screenRegistryValue(item, context, privacy),
      ]),
    );
  return value;
}

/** Postgres-backed, session-scoped registry writes and lexical retrieval. */
export class RegistryMemory {
  constructor(private readonly pool: Pg) {}

  /** Persist a scene summary and its validated diffs atomically; duplicate closes are no-ops. */
  async closeScene(
    sessionId: string,
    sceneId: string,
    summary: string,
    diffs: readonly RegistryDiff[] = [],
    turnId: string | null = null,
    privacy: RegistryPrivacyOptions = {},
    expectedLeaseEpoch?: number,
  ): Promise<boolean> {
    if (!sceneId.trim()) throw new Error('Scene id is required');
    if (!summary.trim() || summary.trim().length > MAX_SCENE_SUMMARY_CHARS)
      throw new Error(
        `Scene summary must contain 1 to ${MAX_SCENE_SUMMARY_CHARS} characters`,
      );
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await lockSessionForDerivedMemoryWrite(client, sessionId);
      if (expectedLeaseEpoch !== undefined) {
        const lease = await client.query<{ epoch: string }>(
          'SELECT epoch FROM session_lease WHERE session_id=$1',
          [sessionId],
        );
        if (Number(lease.rows[0]?.epoch) !== expectedLeaseEpoch)
          throw new DerivedMemoryLeaseLostError();
      }
      const identityContext = await loadRegistryIdentityContext(
        client,
        sessionId,
      );
      const normalized = screenRegistryText(
        summary.trim(),
        identityContext,
        privacy,
      );
      if (normalized.length > MAX_SCENE_SUMMARY_CHARS)
        throw new Error(
          `Scene summary must contain 1 to ${MAX_SCENE_SUMMARY_CHARS} characters`,
        );
      const inserted = await client.query(
        `INSERT INTO scene_summaries(session_id, scene_id, summary, turn_id)
         VALUES ($1, $2, $3, $4) ON CONFLICT (session_id, scene_id) DO NOTHING RETURNING id`,
        [sessionId, sceneId, normalized, turnId],
      );
      if (inserted.rowCount !== 1) {
        await client.query('ROLLBACK');
        return false;
      }
      const summaryId = inserted.rows[0]?.id;
      const tokenToCharacter = new Map(
        [...identityContext.tokenByCharacter].map(([id, token]) => [token, id]),
      );
      if (tokenToCharacter.size && summaryId) {
        const ids = [...tokenToCharacter].flatMap(([token, id]) =>
          normalized.includes(token) ? [id] : [],
        );
        if (ids.length)
          await indexDerivedMemoryRow(
            client,
            sessionId,
            'scene_summary',
            summaryId,
            ids,
          );
      }
      await this.upsertManyInTransaction(
        client,
        sessionId,
        diffs,
        turnId,
        privacy,
      );
      await client.query('COMMIT');
      return true;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /** Durable recap inputs; never reads raw events or transcript rows. */
  async loadRecapMemory(sessionId: string, limit = 8): Promise<string[]> {
    const boundedLimit = Math.max(0, Math.min(20, Math.floor(limit)));
    if (!boundedLimit) return [];
    const { rows } = await this.pool.query<{ text: string }>(
      `SELECT concat('Scene ', scene_id, ': ', summary) AS text
         FROM scene_summaries WHERE session_id=$1
        ORDER BY created_at DESC, id DESC LIMIT $2`,
      [sessionId, boundedLimit],
    );
    // Registry facts are DM continuity data, not inherently player-visible. The
    // registry has no per-fact visibility bit, so recap generation must not
    // infer that every current fact is safe to disclose.
    return rows.map((row) => row.text);
  }

  async upsert(
    sessionId: string,
    diff: RegistryDiff | RegistryEvent,
    privacy: RegistryPrivacyOptions = {},
    expectedLeaseEpoch?: number,
  ): Promise<void> {
    const epochAtStart = await this.captureLeaseEpoch(
      sessionId,
      expectedLeaseEpoch,
    );
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this.assertLeaseEpoch(client, sessionId, epochAtStart);
      await this.upsertManyInTransaction(
        client,
        sessionId,
        [diff],
        null,
        privacy,
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async upsertMany(
    sessionId: string,
    diffs: readonly RegistryDiff[],
    privacy: RegistryPrivacyOptions = {},
    expectedLeaseEpoch?: number,
  ): Promise<void> {
    if (!diffs.length) return;
    const epochAtStart = await this.captureLeaseEpoch(
      sessionId,
      expectedLeaseEpoch,
    );
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this.assertLeaseEpoch(client, sessionId, epochAtStart);
      await this.upsertManyInTransaction(
        client,
        sessionId,
        diffs,
        null,
        privacy,
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async persistEventsInTransaction(
    client: PoolClient,
    sessionId: string,
    events: readonly RegistryEvent[],
    turnId: string | null = null,
    privacy: RegistryPrivacyOptions = {},
  ): Promise<void> {
    await this.upsertManyInTransaction(
      client,
      sessionId,
      events,
      turnId,
      privacy,
    );
  }

  /** Remove registry versions written by reverted turns and restore the versions they superseded. */
  async removeTurnsInTransaction(
    client: PoolClient,
    sessionId: string,
    turnIds: readonly string[],
  ): Promise<void> {
    await client.query(
      `UPDATE registry_facts SET superseded_by=NULL
        WHERE entry_id IN (SELECT id FROM registry_entries WHERE session_id=$1)
          AND superseded_by IN (SELECT f.id FROM registry_facts f
          JOIN registry_entries e ON e.id=f.entry_id
         WHERE e.session_id=$1 AND e.turn_id = ANY($2::text[]))`,
      [sessionId, turnIds],
    );
    await client.query(
      `UPDATE registry_entries SET superseded_by=NULL
        WHERE session_id=$1 AND superseded_by IN (
          SELECT id FROM registry_entries WHERE session_id=$1 AND turn_id = ANY($2::text[]))`,
      [sessionId, turnIds],
    );
    await client.query(
      'DELETE FROM registry_entries WHERE session_id=$1 AND turn_id = ANY($2::text[])',
      [sessionId, turnIds],
    );
  }

  private async captureLeaseEpoch(
    sessionId: string,
    expectedLeaseEpoch?: number,
  ): Promise<number | null> {
    if (expectedLeaseEpoch !== undefined) return expectedLeaseEpoch;
    const lease = await this.pool.query<{ epoch: string }>(
      'SELECT epoch FROM session_lease WHERE session_id=$1',
      [sessionId],
    );
    return lease.rows[0] ? Number(lease.rows[0].epoch) : null;
  }

  private async assertLeaseEpoch(
    client: PoolClient,
    sessionId: string,
    expectedLeaseEpoch: number | null,
  ): Promise<void> {
    await lockSessionForDerivedMemoryWrite(client, sessionId);
    const lease = await client.query<{ epoch: string }>(
      'SELECT epoch FROM session_lease WHERE session_id=$1 FOR SHARE',
      [sessionId],
    );
    const actual = lease.rows[0] ? Number(lease.rows[0].epoch) : null;
    if (actual !== expectedLeaseEpoch) throw new DerivedMemoryLeaseLostError();
  }

  private async upsertManyInTransaction(
    client: PoolClient,
    sessionId: string,
    diffs: readonly (RegistryDiff | RegistryEvent)[],
    turnId: string | null = null,
    privacy: RegistryPrivacyOptions = {},
  ): Promise<void> {
    await lockSessionForDerivedMemoryWrite(client, sessionId);
    const identityContext = await loadRegistryIdentityContext(
      client,
      sessionId,
    );
    const screened = diffs.map(
      (diff) =>
        screenRegistryValue(diff, identityContext, privacy) as
          | RegistryDiff
          | RegistryEvent,
    );
    const tokenByCharacter = identityContext.tokenByCharacter;
    for (const diff of screened) {
      const normalized = this.fromDiff(diff);
      const entryId = await this.writeEntry(
        client,
        sessionId,
        normalized.kind,
        normalized.id,
        normalized.after,
        normalized.aliases,
        normalized.supersedesFacts,
        turnId,
      );
      if (entryId) {
        const body = JSON.stringify(diff);
        const ids = [...tokenByCharacter].flatMap(([characterId, token]) =>
          body.includes(token) ? [characterId] : [],
        );
        if (ids.length)
          await indexDerivedMemoryRow(
            client,
            sessionId,
            'registry_entry',
            entryId,
            ids,
          );
      }
    }
  }

  private fromDiff(diff: RegistryDiff | RegistryEvent): {
    kind: RegistryDiff['kind'];
    id: string;
    after: Record<string, unknown>;
    aliases?: string[];
    supersedesFacts?: Record<string, string>;
  } {
    if ('kind' in diff) return diff;
    switch (diff.type) {
      case 'NpcUpserted':
        return { kind: 'npc', id: diff.npc.id, after: diff.npc };
      case 'LocationUpserted':
        return { kind: 'location', id: diff.location.id, after: diff.location };
      case 'QuestUpdated':
        return { kind: 'quest', id: diff.quest.id, after: diff.quest };
      case 'FlagSet':
        return { kind: 'flag', id: diff.flag.id, after: diff.flag };
      case 'RulingLogged':
        return { kind: 'ruling', id: diff.ruling.id, after: diff.ruling };
      default:
        throw new Error('Unsupported registry event');
    }
  }

  private async writeEntry(
    client: PoolClient,
    sessionId: string,
    kind: RegistryDiff['kind'],
    entityId: string,
    payload: Record<string, unknown>,
    aliases: string[] | undefined = undefined,
    supersedesFacts: Record<string, string> = {},
    turnId: string | null = null,
  ): Promise<string | undefined> {
    await client.query(
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      [`${sessionId}:${kind}:${entityId}`],
    );
    const current = await client.query<EntryRow>(
      `SELECT id, version, payload, name, aliases, mentioned_at
         FROM registry_entries WHERE session_id=$1 AND entity_type=$2 AND entity_id=$3
          AND superseded_by IS NULL FOR UPDATE`,
      [sessionId, kind, entityId],
    );
    const prior = current.rows[0];
    aliases ??= prior?.aliases ?? [];
    payload = validatePayload(kind, entityId, payload, aliases);
    const priorFacts = factsFrom(prior?.payload ?? {});
    const nextFacts = factsFrom(payload);
    const currentFacts = new Set(priorFacts);
    for (const fact of Object.keys(supersedesFacts)) currentFacts.delete(fact);
    for (const fact of Object.values(supersedesFacts)) currentFacts.add(fact);
    if ([...currentFacts].some((fact) => !nextFacts.includes(fact)))
      throw new Error(
        'Registry facts are append-only; supersede instead of deleting or rewriting',
      );
    for (const [oldFact, replacement] of Object.entries(supersedesFacts)) {
      if (
        oldFact === replacement ||
        !priorFacts.includes(oldFact) ||
        !nextFacts.includes(replacement)
      )
        throw new Error(
          'A superseding fact must identify an existing fact and a new current fact',
        );
    }
    if (
      JSON.stringify(prior?.payload) === JSON.stringify(payload) &&
      JSON.stringify(prior?.aliases ?? []) === JSON.stringify(aliases)
    )
      return prior?.id;

    const inserted = await client.query<{ id: string }>(
      `INSERT INTO registry_entries(session_id, entity_type, entity_id, version, name, aliases, payload, supersedes_id, mentioned_at, turn_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [
        sessionId,
        kind,
        entityId,
        (prior?.version ?? 0) + 1,
        entityName(kind, payload),
        aliases,
        payload,
        prior?.id ?? null,
        Number(prior?.mentioned_at ?? 0) + 1,
        turnId,
      ],
    );
    const nextId = inserted.rows[0]!.id;
    if (prior) {
      await client.query(
        'UPDATE registry_entries SET superseded_by=$2 WHERE id=$1',
        [prior.id, nextId],
      );
    }
    const insertedFacts = new Map<string, string>();
    for (const fact of nextFacts) {
      const oldFact =
        Object.entries(supersedesFacts).find(
          ([, replacement]) => replacement === fact,
        )?.[0] ?? fact;
      const result = await client.query<{ id: string }>(
        `INSERT INTO registry_facts(entry_id, fact, supersedes_id)
         VALUES ($1,$2,(SELECT old.id FROM registry_facts old
           JOIN registry_entries e ON e.id=old.entry_id
          WHERE e.session_id=$3 AND e.entity_type=$5 AND e.entity_id=$6
            AND old.fact=$4 AND old.superseded_by IS NULL
          ORDER BY e.version DESC, old.created_at DESC LIMIT 1))
         ON CONFLICT(entry_id,fact) DO NOTHING RETURNING id`,
        [nextId, fact, sessionId, oldFact ?? fact, kind, entityId],
      );
      if (result.rows[0]) insertedFacts.set(fact, result.rows[0].id);
    }
    for (const [oldFact, replacement] of Object.entries(supersedesFacts)) {
      const replacementId = insertedFacts.get(replacement);
      if (replacementId) {
        await client.query(
          `UPDATE registry_facts SET superseded_by=$1
            WHERE id=(SELECT old.id FROM registry_facts old
              JOIN registry_entries e ON e.id=old.entry_id
             WHERE e.session_id=$3 AND e.entity_type=$4 AND e.entity_id=$5
               AND old.fact=$2 AND old.superseded_by IS NULL
             ORDER BY e.version DESC, old.created_at DESC LIMIT 1)`,
          [replacementId, oldFact, sessionId, kind, entityId],
        );
      }
    }
    await client.query(
      `UPDATE registry_entries e SET search_document = ${REGISTRY_SEARCH_DOCUMENT_SQL} WHERE e.id=$1`,
      [nextId],
    );
    return nextId;
  }

  async entities(sessionId: string): Promise<RegistryEntity[]> {
    const result = await this.pool.query<{
      entity_id: string;
      name: string;
      aliases: string[];
      mentioned_at: string;
      facts: string[];
    }>(
      `SELECT e.entity_id, e.name, e.aliases, e.mentioned_at,
              coalesce(array_agg(f.fact ORDER BY f.id) FILTER (WHERE f.id IS NOT NULL AND f.superseded_by IS NULL), '{}') AS facts
         FROM registry_entries e LEFT JOIN registry_facts f ON f.entry_id=e.id
        WHERE e.session_id=$1 AND e.superseded_by IS NULL GROUP BY e.id
        ORDER BY e.entity_id`,
      [sessionId],
    );
    return result.rows.map((row) => ({
      entityId: row.entity_id,
      name: row.name,
      aliases: row.aliases,
      facts: row.facts,
      mentionedAt: Number(row.mentioned_at),
    }));
  }

  async mentionedFacts(
    sessionId: string,
    playerText: string,
    lastDmText: string,
  ): Promise<RegistryFact[]> {
    return extractMentionedRegistryFacts(
      `${playerText}\n${lastDmText}`,
      await this.entities(sessionId),
    ).slice(0, MAX_ENTITY_FACTS);
  }

  async contextFor(
    sessionId: string,
    playerText: string,
    lastDmText: string,
    limit = MAX_MEMORY_RESULTS,
  ): Promise<{ registryFacts: RegistryFact[]; retrievedMemory: string[] }> {
    const query = `${playerText}\n${lastDmText}`;
    const [registryFacts, retrievedMemory] = await Promise.all([
      this.mentionedFacts(sessionId, playerText, lastDmText),
      this.retrieve(sessionId, query, limit),
    ]);
    return { registryFacts, retrievedMemory };
  }

  async retrieve(
    sessionId: string,
    query: string,
    limit = MAX_MEMORY_RESULTS,
  ): Promise<string[]> {
    const boundedLimit = Math.max(
      0,
      Math.min(MAX_MEMORY_RESULTS, Math.floor(limit)),
    );
    if (!boundedLimit || !query.trim()) return [];
    const { rows } = await this.pool.query<{ text: string }>(
      `WITH terms AS (SELECT websearch_to_tsquery('english', $2) AS q),
       entries AS (
         SELECT e.id, e.entity_id, e.name,
                e.search_document AS body,
                GREATEST(ts_rank_cd(e.search_vector, terms.q), similarity(e.search_names, lower($2)) * 0.1) AS rank,
                e.created_at
           FROM registry_entries e CROSS JOIN terms
          WHERE e.session_id=$1 AND e.superseded_by IS NULL
            AND (e.search_vector @@ terms.q OR e.search_names % lower($2))
       ), summaries AS (
         SELECT s.id, s.scene_id AS entity_id, 'scene summary' AS name, s.summary AS body,
                ts_rank_cd(s.search_vector, terms.q) AS rank, s.created_at
           FROM scene_summaries s CROSS JOIN terms
          WHERE s.session_id=$1 AND s.search_vector @@ terms.q
       ), combined AS (
         SELECT id, entity_id, name, body, rank, created_at FROM entries
         UNION ALL SELECT id, entity_id, name, body, rank, created_at FROM summaries
       )
       SELECT concat(name, ': ', body) AS text FROM combined
        ORDER BY rank DESC, created_at, entity_id, id LIMIT $3`,
      [sessionId, query, boundedLimit],
    );
    const results: string[] = [];
    let chars = 0;
    for (const row of rows) {
      if (chars >= MAX_MEMORY_CHARS) break;
      const text = row.text.slice(0, MAX_MEMORY_CHARS - chars);
      results.push(text);
      chars += text.length;
    }
    return results;
  }
}
