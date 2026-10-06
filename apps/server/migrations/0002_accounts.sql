CREATE EXTENSION IF NOT EXISTS citext;
CREATE TABLE accounts (
 id uuid PRIMARY KEY, email citext NOT NULL UNIQUE, password_hash text NOT NULL, display_name text NOT NULL,
 status text NOT NULL DEFAULT 'pending_email' CHECK (status IN ('pending_email','active','suspended','deleting','deleted')),
 is_adult boolean NOT NULL CHECK (is_adult), age_checked_at timestamptz NOT NULL,
 terms_version text NOT NULL, terms_accepted_at timestamptz NOT NULL,
 mature_opt_out boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now(),
 deletion_requested_at timestamptz
);
ALTER TABLE sessions ADD CONSTRAINT sessions_owner_account_fk FOREIGN KEY (owner_account_id) REFERENCES accounts(id);
CREATE TABLE auth_sessions (
 token_hash text PRIMARY KEY, account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
 expires_at timestamptz NOT NULL, absolute_expires_at timestamptz NOT NULL,
 last_active_at timestamptz NOT NULL, ua_hash text, ua_label text
);
CREATE TABLE ws_tickets (
 ticket_hash text PRIMARY KEY, account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
 session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
 expires_at timestamptz NOT NULL, used_at timestamptz
);
CREATE TABLE email_tokens (
 token_hash text PRIMARY KEY, account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
 kind text NOT NULL CHECK (kind IN ('verify','reset')), expires_at timestamptz NOT NULL, used_at timestamptz
);
CREATE TABLE export_jobs (
 id uuid PRIMARY KEY, account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
 status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','completed','failed')),
 requested_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz, expires_at timestamptz,
 archive_key text, error_code text
);
CREATE TABLE deletion_jobs (
 id uuid PRIMARY KEY, account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
 status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','completed','failed')),
 requested_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz, error_code text
);
