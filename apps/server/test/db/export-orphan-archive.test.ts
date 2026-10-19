import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { withTestDatabase } from './testDb.js';
import { processExport } from '../../src/accounts/export.js';

describe('export archive is not orphaned when the completion write fails', () => {
  it('deletes the stored archive and marks the job failed', async () =>
    withTestDatabase(async ({ pool }) => {
      const accountId = randomUUID();
      const jobId = randomUUID();
      await pool.query(
        "CREATE TABLE accounts(id uuid PRIMARY KEY,email text,display_name text,status text,is_adult bool,age_checked_at timestamptz,terms_version text,terms_accepted_at timestamptz,mature_opt_out bool,content_lines text[] NOT NULL DEFAULT '{}',content_veils text[] NOT NULL DEFAULT '{}',created_at timestamptz)",
      );
      await pool.query(
        'CREATE TABLE auth_sessions(account_id uuid,ua_label text,last_active_at timestamptz,expires_at timestamptz,absolute_expires_at timestamptz)',
      );
      await pool.query(
        'CREATE TABLE sessions(id uuid,owner_account_id uuid,status text,created_at timestamptz,last_active_at timestamptz,archived_at timestamptz,character jsonb)',
      );
      await pool.query(
        'CREATE TABLE snapshots(session_id uuid,seq bigint,state jsonb)',
      );
      await pool.query(
        'CREATE TABLE events(session_id uuid,seq bigint,turn_id uuid,type text,payload jsonb)',
      );
      await pool.query(
        'CREATE TABLE scene_summaries(id bigserial PRIMARY KEY,session_id uuid,scene_id text,summary text)',
      );
      await pool.query(
        'CREATE TABLE export_jobs(id uuid PRIMARY KEY,account_id uuid,status text,requested_at timestamptz DEFAULT now(),completed_at timestamptz,expires_at timestamptz,archive_key text,error_code text)',
      );
      await pool.query(
        "INSERT INTO accounts(id,email,display_name,status,is_adult,age_checked_at,terms_version,terms_accepted_at,mature_opt_out,created_at) VALUES($1,'person@example.test','Player','active',true,now(),'v1',now(),false,now())",
        [accountId],
      );
      await pool.query(
        "INSERT INTO export_jobs(id,account_id,status) VALUES($1,$2,'pending')",
        [jobId, accountId],
      );
      await pool.query(`
        CREATE FUNCTION fail_completion() RETURNS trigger AS $$
        BEGIN RAISE EXCEPTION 'completion write failed'; END $$ LANGUAGE plpgsql;
        CREATE TRIGGER fail_completion BEFORE UPDATE ON export_jobs
          FOR EACH ROW WHEN (NEW.status = 'completed') EXECUTE FUNCTION fail_completion();
      `);

      const stored = new Map<string, string>();
      await processExport(pool, jobId, accountId, {
        put: async (key, contents) => {
          stored.set(key, contents);
        },
        get: async (key) => stored.get(key) ?? '',
        delete: async (key) => {
          stored.delete(key);
        },
      });

      expect(stored.size).toBe(0);
      const job = (
        await pool.query<{
          status: string;
          error_code: string;
          archive_key: string | null;
        }>(
          'SELECT status,error_code,archive_key FROM export_jobs WHERE id=$1',
          [jobId],
        )
      ).rows[0];
      expect(job).toEqual({
        status: 'failed',
        error_code: 'EXPORT_FAILED',
        archive_key: null,
      });
    }));
});
