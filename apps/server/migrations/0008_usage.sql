CREATE TABLE endpoint_usage (
 id bigserial PRIMARY KEY,
 session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
 turn_id uuid NOT NULL,
 purpose text NOT NULL CHECK (purpose IN ('narration','summary','classification','moderation')),
 model_id text NOT NULL,
 input_tokens integer NOT NULL CHECK (input_tokens >= 0),
 output_tokens integer NOT NULL CHECK (output_tokens >= 0),
 cached_tokens integer NOT NULL DEFAULT 0 CHECK (cached_tokens >= 0),
 estimated boolean NOT NULL DEFAULT false,
 latency_ms integer NOT NULL CHECK (latency_ms >= 0),
 retries integer NOT NULL DEFAULT 0 CHECK (retries >= 0),
 error_code text,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX endpoint_usage_session_created_idx ON endpoint_usage(session_id, created_at);
CREATE INDEX endpoint_usage_created_idx ON endpoint_usage(created_at);
