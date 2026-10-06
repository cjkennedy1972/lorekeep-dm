import { readFileSync } from 'node:fs';
export const up = (pgm) => { pgm.sql(readFileSync(new URL('./0002_accounts.sql', import.meta.url), 'utf8')); };
export const down = (pgm) => { pgm.sql('DROP TABLE deletion_jobs,export_jobs,email_tokens,ws_tickets,auth_sessions; ALTER TABLE sessions DROP CONSTRAINT sessions_owner_account_fk; DROP TABLE accounts; DROP EXTENSION citext;'); };
