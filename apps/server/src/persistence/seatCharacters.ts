import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { CharacterSchema, type Character } from '@game/schema';
import { loadCatalog } from '@game/rules-engine/catalog-node';
import { validateCharacter } from '@game/rules-engine';
import { getIndexedDerivedMemoryRows } from '../dm/characterReferences.js';

const catalog = loadCatalog();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUnverifiedReferenceCoverage(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message === 'Reference-index coverage is unverified; defer deletion'
  );
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Immutable rules input; expended resources and mutable combat state are session-owned. */
export function characterRulesInput(character: Character) {
  return {
    id: character.id,
    name: character.name,
    speciesId: character.speciesId,
    classId: character.classId,
    level: character.level,
    abilities: character.abilities,
    proficiencies: character.proficiencies,
    equipment: character.equipment,
    spellsKnown: character.spellsKnown,
    spellsPrepared: character.spellsPrepared,
    slots: Object.fromEntries(
      Object.entries(character.slots).map(([level, slot]) => [
        level,
        { max: slot.max },
      ]),
    ),
  };
}

export class SeatCharacterError extends Error {
  constructor(
    readonly code:
      | 'NOT_FOUND'
      | 'NOT_OWNER'
      | 'STALE_REVISION'
      | 'INVALID_CHARACTER'
      | 'NOT_SEATED'
      | 'SOLO_SESSION'
      | 'ALREADY_BOUND'
      | 'ACCOUNT_INACTIVE'
      | 'SESSION_INACTIVE'
      | 'CHARACTER_BOUND'
      | 'SESSION_HELD'
      | 'SESSION_BUSY',
  ) {
    super(code);
    this.name = 'SeatCharacterError';
  }
}

/** Persistence boundary for account-owned reusable sheets and party seat snapshots. */
export class SeatCharacterRepository {
  constructor(private readonly db: Pool) {}

  async validateLateJoinSelection(
    accountId: string,
    characterId: string,
    expectedRevision: number,
  ): Promise<{ name: string; classId: string; level: number }> {
    const account = await this.db.query<{ status: string }>(
      'SELECT status FROM accounts WHERE id=$1',
      [accountId],
    );
    if (account.rows[0]?.status !== 'active')
      throw new SeatCharacterError('ACCOUNT_INACTIVE');
    const result = await this.db.query<{
      character: unknown;
      revision: number;
    }>(
      `SELECT character,revision FROM account_characters
        WHERE id=$1 AND account_id=$2`,
      [characterId, accountId],
    );
    // Keep foreign and unknown character IDs observationally identical.
    const row = result.rows[0];
    if (!row) throw new SeatCharacterError('NOT_FOUND');
    if (row.revision !== expectedRevision)
      throw new SeatCharacterError('STALE_REVISION');
    const parsed = CharacterSchema.safeParse(row.character);
    if (!parsed.success || validateCharacter(parsed.data, catalog).length)
      throw new SeatCharacterError('INVALID_CHARACTER');
    return {
      name: parsed.data.name,
      classId: parsed.data.classId,
      level: parsed.data.level,
    };
  }

  async listOwnedCharacters(accountId: string) {
    const result = await this.db.query<{
      id: string;
      revision: number;
      name: string;
      class_id: string;
      species_id: string;
      level: number;
    }>(
      `SELECT id,revision,character->>'name' AS name,
              character->>'classId' AS class_id,character->>'speciesId' AS species_id,
              (character->>'level')::integer AS level
         FROM account_characters WHERE account_id=$1 ORDER BY created_at,id`,
      [accountId],
    );
    return result.rows.map((row) => ({
      id: row.id,
      revision: row.revision,
      name: row.name,
      classId: row.class_id,
      speciesId: row.species_id,
      level: row.level,
    }));
  }

  async saveOwnedCharacter(
    accountId: string,
    character: Character,
    expectedRevision?: number,
  ) {
    if (
      !UUID.test(accountId) ||
      !CharacterSchema.safeParse(character).success ||
      validateCharacter(character, catalog).length
    )
      throw new SeatCharacterError('INVALID_CHARACTER');
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      const account = await client.query<{ status: string }>(
        'SELECT status FROM accounts WHERE id=$1 FOR UPDATE',
        [accountId],
      );
      if (account.rows[0]?.status !== 'active')
        throw new SeatCharacterError('ACCOUNT_INACTIVE');
      const result =
        expectedRevision === undefined
          ? await client.query<{ revision: number }>(
              `INSERT INTO account_characters(id, account_id, character) VALUES($1,$2,$3::jsonb)
             ON CONFLICT (id) DO NOTHING
             RETURNING revision`,
              [character.id, accountId, JSON.stringify(character)],
            )
          : await client.query<{ revision: number }>(
              `UPDATE account_characters SET character=$3::jsonb, revision=revision+1, updated_at=now()
             WHERE id=$1 AND account_id=$2 AND revision=$4 RETURNING revision`,
              [
                character.id,
                accountId,
                JSON.stringify(character),
                expectedRevision,
              ],
            );
      if (!result.rowCount) {
        const prior = await client.query<{
          account_id: string;
          revision: number;
        }>('SELECT account_id,revision FROM account_characters WHERE id=$1', [
          character.id,
        ]);
        if (!prior.rows[0]) throw new SeatCharacterError('NOT_FOUND');
        // Creation IDs are client-supplied, so foreign and unknown collisions
        // must be indistinguishable to avoid an existence oracle.
        if (expectedRevision === undefined)
          throw new SeatCharacterError('NOT_FOUND');
        if (prior.rows[0].account_id !== accountId)
          throw new SeatCharacterError('NOT_OWNER');
        throw new SeatCharacterError('STALE_REVISION');
      }
      await client.query('COMMIT');
      return result.rows[0]!.revision;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async deleteOwnedCharacter(accountId: string, characterId: string) {
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      const account = await client.query<{ status: string }>(
        'SELECT status FROM accounts WHERE id=$1 FOR UPDATE',
        [accountId],
      );
      if (account.rows[0]?.status !== 'active')
        throw new SeatCharacterError('ACCOUNT_INACTIVE');
      const ownedCharacter = await client.query(
        'SELECT id FROM account_characters WHERE id=$1 AND account_id=$2 FOR UPDATE',
        [characterId, accountId],
      );
      if (!ownedCharacter.rowCount) {
        await client.query('COMMIT');
        return false;
      }
      // Resolve only sessions with an exact mapping or indexed reference. Any
      // session-level hold or incomplete index coverage aborts this transaction
      // before character, mapping, or derived rows are changed.
      const referencedSessions = await client.query<{ session_id: string }>(
        `SELECT token.session_id FROM session_character_tokens token WHERE token.character_id=$1::uuid
         UNION SELECT reference.session_id FROM derived_memory_character_refs reference WHERE reference.character_id=$1::uuid
         UNION SELECT binding.session_id FROM session_seat_characters binding WHERE binding.character_id=$1::uuid
         UNION SELECT id AS session_id FROM sessions WHERE character_id=$1::text`,
        [characterId],
      );
      const sessionIds = referencedSessions.rows
        .map(({ session_id }) => session_id)
        .sort();
      const indexedRows: Array<{
        sessionId: string;
        rowKind: 'scene_summary' | 'registry_entry';
        rowId: string;
      }> = [];
      for (const sessionId of sessionIds) {
        await client.query('SELECT id FROM sessions WHERE id=$1 FOR UPDATE', [
          sessionId,
        ]);
        const held = await client.query(
          "SELECT 1 FROM legal_holds WHERE kind='session' AND item_id=$1",
          [sessionId],
        );
        if (held.rowCount) throw new SeatCharacterError('SESSION_HELD');
        const rows = await getIndexedDerivedMemoryRows(
          client,
          sessionId,
          characterId,
        );
        indexedRows.push(...rows.map((row) => ({ sessionId, ...row })));
      }
      // Fence active session writers before removing indexed rows. A busy session
      // leaves the transaction unchanged and can be resumed by repeating deletion.
      for (const sessionId of sessionIds) {
        const fence = await client.query(
          `INSERT INTO session_lease(session_id,node_id,expires_at,epoch)
           VALUES ($1,'retention:characterDeletion',clock_timestamp() + interval '5 minutes',1)
           ON CONFLICT (session_id) DO UPDATE SET
             node_id=EXCLUDED.node_id, expires_at=EXCLUDED.expires_at,
             epoch=session_lease.epoch + 1
           WHERE session_lease.expires_at <= clock_timestamp()
           RETURNING epoch`,
          [sessionId],
        );
        if (!fence.rowCount) throw new SeatCharacterError('SESSION_BUSY');
      }
      for (const sessionId of sessionIds) {
        const references = indexedRows.filter(
          (row) => row.sessionId === sessionId,
        );
        if (references.length)
          await client.query(
            'DELETE FROM derived_memory_character_refs reference USING unnest($2::text[],$3::bigint[]) AS deleted(row_kind,row_id) WHERE reference.session_id=$1 AND reference.row_kind=deleted.row_kind AND reference.row_id=deleted.row_id',
            [
              sessionId,
              references.map((row) => row.rowKind),
              references.map((row) => row.rowId),
            ],
          );
      }
      const summaryIds = indexedRows
        .filter((row) => row.rowKind === 'scene_summary')
        .map((row) => row.rowId);
      if (summaryIds.length)
        await client.query(
          'DELETE FROM scene_summaries WHERE id = ANY($1::bigint[])',
          [summaryIds],
        );
      const registryIdsBySession = new Map<string, string[]>();
      for (const row of indexedRows) {
        if (row.rowKind !== 'registry_entry') continue;
        const ids = registryIdsBySession.get(row.sessionId) ?? [];
        ids.push(row.rowId);
        registryIdsBySession.set(row.sessionId, ids);
      }
      for (const [sessionId, ids] of registryIdsBySession) {
        // Keep surviving versions and facts, but remove stale supersession edges
        // that would otherwise point at the deleted version.
        await client.query(
          `WITH RECURSIVE lineage(successor_id,ancestor_id,depth) AS (
             SELECT successor.id,removed.supersedes_id,1
             FROM registry_entries successor JOIN registry_entries removed ON successor.supersedes_id=removed.id
             WHERE removed.id=ANY($2::bigint[]) AND successor.id<>ALL($2::bigint[]) AND successor.session_id=$1 AND removed.session_id=$1
             UNION ALL
             SELECT lineage.successor_id,removed.supersedes_id,lineage.depth+1
             FROM lineage JOIN registry_entries removed ON removed.id=lineage.ancestor_id
             WHERE lineage.ancestor_id=ANY($2::bigint[]) AND removed.session_id=$1
           ), nearest AS (
             SELECT DISTINCT ON (successor_id) successor_id,ancestor_id
             FROM lineage WHERE ancestor_id IS NULL OR ancestor_id<>ALL($2::bigint[])
             ORDER BY successor_id,depth
           )
           UPDATE registry_entries successor
           SET supersedes_id=COALESCE(nearest.ancestor_id,successor.id)
           FROM nearest WHERE successor.id=nearest.successor_id`,
          [sessionId, ids],
        );
        await client.query(
          `UPDATE registry_entries SET superseded_by=NULL
           WHERE session_id=$1 AND superseded_by=ANY($2::bigint[]) AND id<>ALL($2::bigint[])`,
          [sessionId, ids],
        );
        // Surviving facts may point across versions into a removed entry.
        await client.query(
          `UPDATE registry_facts surviving SET supersedes_id=NULL
           WHERE surviving.supersedes_id IN (
             SELECT removed.id FROM registry_facts removed
             WHERE removed.entry_id=ANY($1::bigint[])
           ) AND surviving.entry_id<>ALL($1::bigint[])`,
          [ids],
        );
        await client.query(
          'DELETE FROM registry_entries WHERE id = ANY($1::bigint[])',
          [ids],
        );
        await client.query(
          `UPDATE registry_entries SET supersedes_id=NULL,version=1
           WHERE session_id=$1 AND supersedes_id=id AND id<>ALL($2::bigint[])`,
          [sessionId, ids],
        );
      }
      for (const sessionId of sessionIds) {
        await client.query(
          'DELETE FROM derived_memory_character_refs WHERE session_id=$1 AND character_id=$2::uuid',
          [sessionId, characterId],
        );
        await client.query(
          'DELETE FROM session_character_tokens WHERE session_id=$1 AND character_id=$2::uuid',
          [sessionId, characterId],
        );
        await client.query(
          "UPDATE session_lease SET node_id='', expires_at=clock_timestamp() WHERE session_id=$1 AND node_id='retention:characterDeletion'",
          [sessionId],
        );
      }
      // No character FK is used because held sessions retain mapping/refs; the
      // hold check above covers every token-mapped session before this cleanup.
      await client.query(
        'DELETE FROM derived_memory_character_refs WHERE character_id=$1::uuid',
        [characterId],
      );
      await client.query(
        'DELETE FROM session_character_tokens WHERE character_id=$1::uuid',
        [characterId],
      );
      const deleted = await client.query(
        'DELETE FROM account_characters WHERE id=$1 AND account_id=$2',
        [characterId, accountId],
      );
      await client.query('COMMIT');
      return deleted.rowCount === 1;
    } catch (error) {
      await client.query('ROLLBACK');
      const pgError = error as { code?: string; constraint?: string };
      if (
        pgError.code === '23503' &&
        pgError.constraint === 'session_seat_characters_active_character_fkey'
      )
        throw new SeatCharacterError('CHARACTER_BOUND');
      throw error;
    } finally {
      client.release();
    }
  }

  async bind(input: {
    sessionId: string;
    seatId: string;
    accountId: string;
    characterId: string;
    expectedRevision: number;
    snapshotCharacter?: unknown;
  }) {
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      const result = await this.bindWithClient(client, input);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /** Bind within a caller-owned transaction so the Room event can commit atomically. */
  async bindWithClient(
    client: import('pg').PoolClient,
    input: {
      sessionId: string;
      seatId: string;
      accountId: string;
      characterId: string;
      expectedRevision: number;
      pendingSeatJoin?: boolean;
      allowSolo?: boolean;
      /** Authoritative immutable session sheet for legacy owner conversion. */
      snapshotCharacter?: unknown;
      snapshotRevision?: null;
    },
  ) {
    try {
      const session = await client.query<{ mode: string; status: string }>(
        'SELECT mode,status FROM sessions WHERE id=$1 FOR SHARE',
        [input.sessionId],
      );
      if (!session.rowCount) throw new SeatCharacterError('NOT_FOUND');
      if (session.rows[0]!.mode !== 'party' && !input.allowSolo)
        throw new SeatCharacterError('SOLO_SESSION');
      if (session.rows[0]!.status !== 'active')
        throw new SeatCharacterError('SESSION_INACTIVE');
      const account = await client.query<{ status: string }>(
        'SELECT status FROM accounts WHERE id=$1 FOR SHARE',
        [input.accountId],
      );
      if (account.rows[0]?.status !== 'active')
        throw new SeatCharacterError('ACCOUNT_INACTIVE');
      const member = await client.query(
        `SELECT 1 FROM events j WHERE j.session_id=$1 AND j.type='SeatJoined'
          AND j.payload->>'seatId'=$2 AND j.payload->>'accountId'=$3
          AND NOT EXISTS (SELECT 1 FROM events r WHERE r.session_id=j.session_id AND r.type='SeatRevoked'
            AND r.payload->>'seatId'=$2 AND r.seq>j.seq)
          UNION ALL SELECT 1 WHERE $4::boolean LIMIT 1`,
        [
          input.sessionId,
          input.seatId,
          input.accountId,
          input.pendingSeatJoin ?? false,
        ],
      );
      if (!member.rowCount) throw new SeatCharacterError('NOT_SEATED');
      const source = await client.query<{
        character: Character;
        revision: number;
        account_id: string;
      }>(
        'SELECT character, revision, account_id FROM account_characters WHERE id=$1 FOR SHARE',
        [input.characterId],
      );
      if (!source.rowCount) throw new SeatCharacterError('NOT_FOUND');
      const row = source.rows[0]!;
      if (row.account_id !== input.accountId)
        throw new SeatCharacterError('NOT_OWNER');
      if (row.revision !== input.expectedRevision)
        throw new SeatCharacterError('STALE_REVISION');
      const parsed = CharacterSchema.safeParse(
        input.snapshotCharacter ?? row.character,
      );
      if (!parsed.success || validateCharacter(parsed.data, catalog).length)
        throw new SeatCharacterError('INVALID_CHARACTER');
      const sheet = characterRulesInput(parsed.data);
      const snapshotHash = createHash('sha256')
        .update(stableJson(sheet))
        .digest('hex');
      const inserted = await client.query(
        `INSERT INTO session_seat_characters(session_id,seat_id,account_id,character_id,character_revision,character_snapshot,character_snapshot_hash)
         VALUES($1,$2,$3,$4,$5,$6::jsonb,$7) RETURNING id`,
        [
          input.sessionId,
          input.seatId,
          input.accountId,
          input.characterId,
          input.snapshotRevision === null ? null : row.revision,
          JSON.stringify(sheet),
          snapshotHash,
        ],
      );
      return {
        bindingId: inserted.rows[0]!.id as string,
        characterRevision:
          input.snapshotRevision === null ? null : row.revision,
        snapshotHash,
        characterSnapshot: sheet,
      };
    } catch (error) {
      if ((error as { code?: string }).code === '23505')
        throw new SeatCharacterError('ALREADY_BOUND');
      throw error;
    }
  }

  async release(sessionId: string, seatId: string, accountId: string) {
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      const released = await this.releaseWithClient(
        client,
        sessionId,
        seatId,
        accountId,
      );
      await client.query('COMMIT');
      return released;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /** Release within the Room event transaction. The caller owns commit and rollback. */
  async releaseWithClient(
    client: import('pg').PoolClient,
    sessionId: string,
    seatId: string,
    accountId: string,
    /** Seat revocation must release even for ended sessions or inactive accounts. */
    unconditional = false,
  ) {
    if (!unconditional) {
      const session = await client.query<{ status: string }>(
        'SELECT status FROM sessions WHERE id=$1 FOR SHARE',
        [sessionId],
      );
      if (!session.rowCount) throw new SeatCharacterError('NOT_FOUND');
      if (['ended', 'deleting', 'deleted'].includes(session.rows[0]!.status))
        throw new SeatCharacterError('SESSION_INACTIVE');
      const account = await client.query<{ status: string }>(
        'SELECT status FROM accounts WHERE id=$1 FOR SHARE',
        [accountId],
      );
      if (account.rows[0]?.status !== 'active')
        throw new SeatCharacterError('ACCOUNT_INACTIVE');
    }
    const result = await client.query(
      `UPDATE session_seat_characters SET binding_status='released', unbound_at=now()
       WHERE session_id=$1 AND seat_id=$2 AND account_id=$3 AND binding_status='active' RETURNING id`,
      [sessionId, seatId, accountId],
    );
    return result.rowCount === 1;
  }

  /** Called only inside the ADR-017 deletion transaction. Retains anonymous mechanics, not links. */
  static async redactAccount(
    client: import('pg').PoolClient,
    accountId: string,
    fenceSession?: (sessionId: string) => Promise<void>,
  ) {
    const mappings = await client.query<{
      session_id: string;
      character_id: string;
      held: boolean;
    }>(
      `SELECT t.session_id,t.character_id,
              EXISTS (SELECT 1 FROM legal_holds h WHERE h.kind='session' AND h.item_id=t.session_id::text) AS held
       FROM session_character_tokens t
       JOIN account_characters c ON c.id=t.character_id WHERE c.account_id=$1
       UNION
       SELECT b.session_id,b.character_id,
              EXISTS (SELECT 1 FROM legal_holds h WHERE h.kind='session' AND h.item_id=b.session_id::text)
       FROM session_seat_characters b
       JOIN account_characters c ON c.id=b.character_id WHERE c.account_id=$1
       UNION
       SELECT s.id AS session_id,s.character_id::uuid AS character_id,
              EXISTS (SELECT 1 FROM legal_holds h WHERE h.kind='session' AND h.item_id=s.id::text)
       FROM sessions s
       JOIN account_characters c ON c.id::text=s.character_id WHERE c.account_id=$1
       UNION
       SELECT r.session_id,r.character_id,
              EXISTS (SELECT 1 FROM legal_holds h WHERE h.kind='session' AND h.item_id=r.session_id::text) AS held
       FROM derived_memory_character_refs r
       JOIN account_characters c ON c.id=r.character_id WHERE c.account_id=$1`,
      [accountId],
    );
    const mappedSessions = [
      ...new Set(mappings.rows.map((row) => row.session_id)),
    ].sort();
    for (const sessionId of mappedSessions) {
      if (fenceSession) await fenceSession(sessionId);
      else
        await client.query('SELECT id FROM sessions WHERE id=$1 FOR UPDATE', [
          sessionId,
        ]);
      const hold = await client.query(
        "SELECT 1 FROM legal_holds WHERE kind='session' AND item_id=$1",
        [sessionId],
      );
      if (hold.rowCount) throw new SeatCharacterError('SESSION_HELD');
    }
    if (mappings.rows.some(({ held }) => held))
      throw new SeatCharacterError('SESSION_HELD');
    const indexedRows: Array<{
      sessionId: string;
      rowKind: 'scene_summary' | 'registry_entry';
      rowId: string;
    }> = [];
    try {
      for (const mapping of mappings.rows) {
        try {
          const rows = await getIndexedDerivedMemoryRows(
            client,
            mapping.session_id,
            mapping.character_id,
          );
          indexedRows.push(
            ...rows.map((row) => ({ sessionId: mapping.session_id, ...row })),
          );
        } catch (error) {
          if (
            error instanceof Error &&
            error.message === 'Session is held; refusing indexed lookup'
          )
            throw new SeatCharacterError('SESSION_HELD');
          if (!isUnverifiedReferenceCoverage(error)) throw error;
          throw new Error('Derived-memory reference coverage is incomplete');
        }
      }
    } catch (error) {
      if (!isUnverifiedReferenceCoverage(error)) throw error;
      throw new Error('Derived-memory reference coverage is incomplete');
    }
    // Unverified coverage is deferred; even a nominally solo session can contain
    // released participants or unreferenced NPC memory that must not be purged.
    await client.query(
      `UPDATE session_seat_characters SET account_id=NULL, character_id=NULL, character_revision=NULL,
         character_snapshot = jsonb_set(character_snapshot - 'id' - 'name', '{name}', '"Deleted player"'::jsonb),
         binding_status='redacted', unbound_at=COALESCE(unbound_at,now())
       WHERE account_id=$1`,
      [accountId],
    );
    for (const sessionId of new Set(indexedRows.map((row) => row.sessionId))) {
      const references = indexedRows.filter(
        (row) => row.sessionId === sessionId,
      );
      await client.query(
        'DELETE FROM derived_memory_character_refs reference USING unnest($2::text[],$3::bigint[]) AS deleted(row_kind,row_id) WHERE reference.session_id=$1 AND reference.row_kind=deleted.row_kind AND reference.row_id=deleted.row_id',
        [
          sessionId,
          references.map((row) => row.rowKind),
          references.map((row) => row.rowId),
        ],
      );
    }
    const summaryIds = indexedRows
      .filter((row) => row.rowKind === 'scene_summary')
      .map((row) => row.rowId);
    if (summaryIds.length)
      await client.query(
        'DELETE FROM scene_summaries WHERE id = ANY($1::bigint[])',
        [summaryIds],
      );
    // Delete only indexed versions; surviving versions remain available. Remove
    // stale supersession pointers into the deleted set before the parent rows.
    const registryEntriesBySession = new Map<string, string[]>();
    for (const row of indexedRows) {
      if (row.rowKind !== 'registry_entry') continue;
      const ids = registryEntriesBySession.get(row.sessionId) ?? [];
      ids.push(row.rowId);
      registryEntriesBySession.set(row.sessionId, ids);
    }
    for (const [sessionId, entryIds] of registryEntriesBySession) {
      await client.query(
        `WITH RECURSIVE lineage(successor_id,ancestor_id,depth) AS (
           SELECT successor.id,removed.supersedes_id,1
           FROM registry_entries successor JOIN registry_entries removed ON successor.supersedes_id=removed.id
           WHERE removed.id=ANY($2::bigint[]) AND successor.id<>ALL($2::bigint[]) AND successor.session_id=$1 AND removed.session_id=$1
           UNION ALL
           SELECT lineage.successor_id,removed.supersedes_id,lineage.depth+1
           FROM lineage JOIN registry_entries removed ON removed.id=lineage.ancestor_id
           WHERE lineage.ancestor_id=ANY($2::bigint[]) AND removed.session_id=$1
         ), nearest AS (
           SELECT DISTINCT ON (successor_id) successor_id,ancestor_id
           FROM lineage WHERE ancestor_id IS NULL OR ancestor_id<>ALL($2::bigint[])
           ORDER BY successor_id,depth
         )
         UPDATE registry_entries successor
         SET supersedes_id=COALESCE(nearest.ancestor_id,successor.id)
         FROM nearest WHERE successor.id=nearest.successor_id`,
        [sessionId, entryIds],
      );
      await client.query(
        `UPDATE registry_entries SET superseded_by=NULL
         WHERE session_id=$1 AND superseded_by=ANY($2::bigint[]) AND id<>ALL($2::bigint[])`,
        [sessionId, entryIds],
      );
      await client.query(
        `UPDATE registry_facts surviving SET supersedes_id=NULL
         WHERE surviving.supersedes_id IN (
           SELECT removed.id FROM registry_facts removed
           WHERE removed.entry_id=ANY($1::bigint[])
         ) AND surviving.entry_id<>ALL($1::bigint[])`,
        [entryIds],
      );
      await client.query(
        'DELETE FROM registry_entries WHERE id = ANY($1::bigint[])',
        [entryIds],
      );
      await client.query(
        `UPDATE registry_entries SET supersedes_id=NULL,version=1
         WHERE session_id=$1 AND supersedes_id=id AND id<>ALL($2::bigint[])`,
        [sessionId, entryIds],
      );
    }
    await client.query(
      `DELETE FROM derived_memory_character_refs target
      WHERE target.character_id IN (SELECT id FROM account_characters WHERE account_id=$1)
        AND NOT EXISTS (SELECT 1 FROM legal_holds h WHERE h.kind='session' AND h.item_id=target.session_id::text)`,
      [accountId],
    );
    await client.query(
      `DELETE FROM session_character_tokens t
      WHERE t.character_id IN (SELECT id FROM account_characters WHERE account_id=$1)
        AND NOT EXISTS (SELECT 1 FROM legal_holds h WHERE h.kind='session' AND h.item_id=t.session_id::text)`,
      [accountId],
    );
    await client.query('DELETE FROM account_characters WHERE account_id=$1', [
      accountId,
    ]);
  }
}
