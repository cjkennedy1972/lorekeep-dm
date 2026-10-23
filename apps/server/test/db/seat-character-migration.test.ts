import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { down, up } from '../../migrations/0037_seat_character_bindings.js';
import { withTestDatabase } from './testDb.js';

describe('seat-character migration rollback safety', () => {
  it('supports up → non-destructive down → up', async () => {
    await withTestDatabase(async ({ pool }) => {
      await pool.query('CREATE TABLE accounts(id uuid PRIMARY KEY)');
      await pool.query('CREATE TABLE sessions(id uuid PRIMARY KEY)');
      const pgm = { sql: (statement: string) => pool.query(statement) };

      await up(pgm as never);
      await down({} as never);
      await expect(up(pgm as never)).resolves.toBeDefined();

      const tables = await pool.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema=current_schema()
           AND table_name IN ('account_characters','session_seat_characters')`,
      );
      expect(tables.rows.map((row) => row.table_name).sort()).toEqual([
        'account_characters',
        'session_seat_characters',
      ]);
      const trigger = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM pg_trigger
         WHERE tgrelid='session_seat_characters'::regclass
           OR tgrelid='account_characters'::regclass`,
      );
      expect(Number(trigger.rows[0]!.count)).toBeGreaterThan(0);

      const accountId = randomUUID();
      const sessionId = randomUUID();
      const seatId = randomUUID();
      const characterId = randomUUID();
      await pool.query('INSERT INTO accounts(id) VALUES($1)', [accountId]);
      await pool.query('INSERT INTO sessions(id) VALUES($1)', [sessionId]);
      await pool.query(
        'INSERT INTO account_characters(id,account_id,character) VALUES($1,$2,$3)',
        [characterId, accountId, {}],
      );
      await pool.query(
        `INSERT INTO session_seat_characters(session_id,seat_id,account_id,character_id,character_revision,character_snapshot)
         VALUES($1,$2,$3,$4,1,'{}')`,
        [sessionId, seatId, accountId, characterId],
      );
      await expect(
        pool.query('DELETE FROM account_characters WHERE id=$1', [characterId]),
      ).rejects.toMatchObject({
        code: '23503',
        message: expect.stringContaining(
          'character is blocked while an active seat binding exists',
        ),
      });
      await pool.query(
        `UPDATE session_seat_characters
         SET binding_status='released',unbound_at=now()
         WHERE session_id=$1 AND seat_id=$2`,
        [sessionId, seatId],
      );
      await pool.query('DELETE FROM account_characters WHERE id=$1', [
        characterId,
      ]);
      const released = await pool.query<{ character_id: string | null }>(
        'SELECT character_id FROM session_seat_characters WHERE session_id=$1',
        [sessionId],
      );
      expect(released.rows[0]!.character_id).toBeNull();
    });
  });
});
