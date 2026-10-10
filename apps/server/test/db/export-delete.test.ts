import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { withTestDatabase } from './testDb.js';
import { hashPassword } from '../../src/accounts/password.js';
import { createSession, getSession } from '../../src/accounts/sessions.js';
import { processExport } from '../../src/accounts/export.js';
import { requestDeletion } from '../../src/accounts/delete.js';
import { authenticate } from '../../src/accounts/login.js';

describe('export and delete Postgres flow', () => {
  it('exports no credentials and immediately revokes all sessions', async () =>
    withTestDatabase(async ({ pool }) => {
      const id = randomUUID();
      const password_hash = await hashPassword('correct-password');
      await pool.query(
        'CREATE TABLE accounts(id uuid PRIMARY KEY,email text,password_hash text,display_name text,status text,is_adult bool,age_checked_at timestamptz,terms_version text,terms_accepted_at timestamptz,mature_opt_out bool,created_at timestamptz,deletion_requested_at timestamptz)',
      );
      await pool.query(
        'CREATE TABLE auth_sessions(token_hash text PRIMARY KEY,account_id uuid,expires_at timestamptz,absolute_expires_at timestamptz,last_active_at timestamptz,ua_label text)',
      );
      await pool.query(
        'CREATE TABLE sessions(id uuid,owner_account_id uuid,name text,status text,created_at timestamptz,last_active_at timestamptz,archived_at timestamptz,character jsonb)',
      );
      await pool.query('CREATE TABLE snapshots(session_id uuid,seq bigint,state jsonb)');
      await pool.query(
        'CREATE TABLE scene_summaries(id bigserial PRIMARY KEY,session_id uuid,scene_id text,summary text)',
      );
      await pool.query(
        'CREATE TABLE export_jobs(id uuid,account_id uuid,status text,completed_at timestamptz,expires_at timestamptz,archive_key text,error_code text)',
      );
      await pool.query('CREATE TABLE ws_tickets(account_id uuid)');
      await pool.query('CREATE TABLE deletion_jobs(id uuid,account_id uuid)');
      await pool.query(
        "INSERT INTO accounts VALUES($1,'person@example.test',$2,'Player','active',true,now(),'v1',now(),false,now(),null)",
        [id, password_hash],
      );
      const token = await createSession(pool, id, 'Test device');
      let archive = '';
      await pool.query(
        'INSERT INTO export_jobs(id,account_id,status) VALUES($1,$2,$3)',
        [id, id, 'pending'],
      );
      await processExport(pool, id, id, {
        put: async (_key, contents) => {
          archive = contents;
        },
        get: async () => archive,
        delete: async () => {},
      });
      expect(archive).toContain('person@example.test');
      expect(archive).not.toContain('password_hash');
      expect(archive).not.toContain('token_hash');
      expect(archive).not.toContain(password_hash);
      expect(await requestDeletion(pool, id, 'wrong-password')).toBe(false);
      expect(await requestDeletion(pool, id, 'correct-password')).toBe(true);
      expect(await getSession(pool, token)).toBeUndefined();
      expect(
        (await authenticate(pool, 'person@example.test', 'correct-password'))
          .kind,
      ).toBe('deleting');
      expect(
        (await pool.query('SELECT count(*)::int AS n FROM deletion_jobs'))
          .rows[0].n,
      ).toBe(1);
    }));
});
