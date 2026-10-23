import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { CharacterSchema, type Character } from '@game/schema';
import { loadCatalog } from '@game/rules-engine/catalog-node';
import { validateCharacter } from '@game/rules-engine';

const catalog = loadCatalog();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Immutable rules input; expended resources and mutable combat state are session-owned. */
export function characterRulesInput(character: Character) {
  return {
    id: character.id,
    name: character.name,
    speciesId: character.speciesId,
    classId: character.classId,
    backgroundId: character.backgroundId,
    level: character.level,
    abilities: character.abilities,
    proficiencies: character.proficiencies,
    equipment: character.equipment,
    spellsKnown: character.spellsKnown,
    spellsPrepared: character.spellsPrepared,
    slots: Object.fromEntries(
      Object.entries(character.slots).map(([level, slot]) => [level, { max: slot.max }]),
    ),
  };
}

export class SeatCharacterError extends Error {
  constructor(readonly code: 'NOT_FOUND' | 'NOT_OWNER' | 'STALE_REVISION' | 'INVALID_CHARACTER' | 'NOT_SEATED' | 'SOLO_SESSION' | 'ALREADY_BOUND') {
    super(code);
    this.name = 'SeatCharacterError';
  }
}

/** Persistence boundary for account-owned reusable sheets and party seat snapshots. */
export class SeatCharacterRepository {
  constructor(private readonly db: Pool) {}

  async saveOwnedCharacter(accountId: string, character: Character, expectedRevision?: number) {
    if (!UUID.test(accountId) || !CharacterSchema.safeParse(character).success || validateCharacter(character, catalog).length)
      throw new SeatCharacterError('INVALID_CHARACTER');
    const result = expectedRevision === undefined
      ? await this.db.query<{ revision: number }>(
          `INSERT INTO account_characters(id, account_id, character) VALUES($1,$2,$3::jsonb)
           RETURNING revision`, [character.id, accountId, JSON.stringify(character)])
      : await this.db.query<{ revision: number }>(
          `UPDATE account_characters SET character=$3::jsonb, revision=revision+1, updated_at=now()
           WHERE id=$1 AND account_id=$2 AND revision=$4 RETURNING revision`,
          [character.id, accountId, JSON.stringify(character), expectedRevision]);
    if (!result.rowCount) {
      const prior = await this.db.query<{ account_id: string; revision: number }>(
        'SELECT account_id,revision FROM account_characters WHERE id=$1', [character.id]);
      if (prior.rows[0]?.account_id !== accountId) throw new SeatCharacterError('NOT_OWNER');
      throw new SeatCharacterError('STALE_REVISION');
    }
    return result.rows[0]!.revision;
  }

  async bind(input: { sessionId: string; seatId: string; accountId: string; characterId: string; expectedRevision: number }) {
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      const session = await client.query<{ mode: string }>('SELECT mode FROM sessions WHERE id=$1 FOR UPDATE', [input.sessionId]);
      if (!session.rowCount) throw new SeatCharacterError('NOT_FOUND');
      if (session.rows[0]!.mode !== 'party') throw new SeatCharacterError('SOLO_SESSION');
      const member = await client.query(
        `SELECT 1 FROM events j WHERE j.session_id=$1 AND j.type='SeatJoined'
          AND j.payload->>'seatId'=$2 AND j.payload->>'accountId'=$3
          AND NOT EXISTS (SELECT 1 FROM events r WHERE r.session_id=j.session_id AND r.type='SeatRevoked'
            AND r.payload->>'seatId'=$2 AND r.seq>j.seq) LIMIT 1`,
        [input.sessionId, input.seatId, input.accountId]);
      if (!member.rowCount) throw new SeatCharacterError('NOT_SEATED');
      const source = await client.query<{ character: Character; revision: number; account_id: string }>(
        'SELECT character, revision, account_id FROM account_characters WHERE id=$1 FOR SHARE', [input.characterId]);
      if (!source.rowCount) throw new SeatCharacterError('NOT_FOUND');
      const row = source.rows[0]!;
      if (row.account_id !== input.accountId) throw new SeatCharacterError('NOT_OWNER');
      if (row.revision !== input.expectedRevision) throw new SeatCharacterError('STALE_REVISION');
      const parsed = CharacterSchema.safeParse(row.character);
      if (!parsed.success || validateCharacter(parsed.data, catalog).length) throw new SeatCharacterError('INVALID_CHARACTER');
      const sheet = characterRulesInput(parsed.data);
      const snapshotHash = createHash('sha256').update(JSON.stringify(sheet)).digest('hex');
      const inserted = await client.query(
        `INSERT INTO session_seat_characters(session_id,seat_id,account_id,character_id,character_revision,character_snapshot)
         VALUES($1,$2,$3,$4,$5,$6::jsonb) RETURNING id`,
        [input.sessionId, input.seatId, input.accountId, input.characterId, row.revision, JSON.stringify(sheet)]);
      await client.query('COMMIT');
      return { bindingId: inserted.rows[0]!.id as string, characterRevision: row.revision, snapshotHash };
    } catch (error) {
      await client.query('ROLLBACK');
      if ((error as { code?: string }).code === '23505') throw new SeatCharacterError('ALREADY_BOUND');
      throw error;
    } finally { client.release(); }
  }

  async release(sessionId: string, seatId: string) {
    const result = await this.db.query(
      `UPDATE session_seat_characters SET binding_status='released', unbound_at=now()
       WHERE session_id=$1 AND seat_id=$2 AND binding_status='active' RETURNING id`, [sessionId, seatId]);
    return result.rowCount === 1;
  }

  /** Called only inside the ADR-017 deletion transaction. Retains anonymous mechanics, not links. */
  async redactAccount(client: import('pg').PoolClient, accountId: string) {
    await client.query(
      `UPDATE session_seat_characters SET account_id=NULL, character_id=NULL, character_revision=NULL,
         character_snapshot = jsonb_set(character_snapshot - 'id' - 'name', '{name}', '"Deleted player"'::jsonb),
         binding_status='redacted', unbound_at=COALESCE(unbound_at,now())
       WHERE account_id=$1`, [accountId]);
    await client.query('DELETE FROM account_characters WHERE account_id=$1', [accountId]);
  }
}
