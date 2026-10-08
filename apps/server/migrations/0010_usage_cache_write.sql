ALTER TABLE endpoint_usage
  ADD COLUMN cache_write_tokens integer NOT NULL DEFAULT 0 CHECK (cache_write_tokens >= 0);
