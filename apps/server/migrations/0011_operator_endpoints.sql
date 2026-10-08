CREATE TABLE operator_endpoints (
 slot text PRIMARY KEY CHECK (slot IN ('fast','frontier','moderate')),
 base_url text NOT NULL,
 model text NOT NULL,
 api_style text NOT NULL CHECK (api_style IN ('openai','anthropic')),
 encrypted_key text,
 key_fingerprint text,
 context_window integer CHECK (context_window IS NULL OR context_window > 0),
 probe jsonb,
 updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK ((encrypted_key IS NULL) = (key_fingerprint IS NULL))
);
CREATE TABLE operator_endpoint_audit (
 id bigserial PRIMARY KEY,
 slot text NOT NULL CHECK (slot IN ('fast','frontier','moderate')),
 action text NOT NULL CHECK (action IN ('created','updated')),
 created_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL DEFAULT (now() + interval '30 days')
);
CREATE INDEX operator_endpoint_audit_expiry_idx ON operator_endpoint_audit(expires_at);
