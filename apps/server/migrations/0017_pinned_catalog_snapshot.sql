CREATE TABLE catalog_snapshots (
  catalog_version text PRIMARY KEY,
  entries jsonb NOT NULL CHECK (jsonb_typeof(entries) = 'array'),
  created_at timestamptz NOT NULL DEFAULT now()
);
