CREATE TABLE message_reports (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 session_id uuid NOT NULL,
 message_seq bigint NOT NULL,
 reporter_account_id uuid REFERENCES accounts(id) ON DELETE SET NULL,
 author_account_id uuid REFERENCES accounts(id) ON DELETE SET NULL,
 category text NOT NULL CHECK (category IN ('harassment','hate','sexual','threat_or_self_harm','underage','other')),
 reason text NOT NULL DEFAULT '' CHECK (char_length(reason) <= 500),
 context jsonb NOT NULL CHECK (octet_length(context::text) <= 131072),
 status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','reviewed','dismissed','actioned')),
 created_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL DEFAULT (now() + interval '30 days'),
 reviewed_by uuid REFERENCES accounts(id) ON DELETE SET NULL,
 reviewed_at timestamptz,
 CHECK ((status = 'open') = (reviewed_at IS NULL)),
 UNIQUE (session_id, message_seq, reporter_account_id)
);
CREATE INDEX message_reports_queue_idx ON message_reports(status, created_at DESC);
CREATE INDEX message_reports_expiry_idx ON message_reports(expires_at);
CREATE TABLE message_report_audit (
 id bigserial PRIMARY KEY,
 report_id uuid NOT NULL,
 actor_id uuid REFERENCES accounts(id) ON DELETE SET NULL,
 from_status text NOT NULL,
 to_status text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL DEFAULT (now() + interval '30 days')
);
CREATE INDEX message_report_audit_expiry_idx ON message_report_audit(expires_at);
