CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- array_to_string is STABLE, which Postgres rejects in a stored generated column; the
-- result for text[] is deterministic, so wrap it in an IMMUTABLE function.
CREATE FUNCTION registry_immutable_join(parts text[], sep text) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  AS $$ SELECT array_to_string(parts, sep) $$;

CREATE TABLE registry_entries (
  id bigserial PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  entity_type text NOT NULL CHECK (entity_type IN ('npc','location','quest','flag','ruling')),
  entity_id text NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  name text NOT NULL DEFAULT '',
  aliases text[] NOT NULL DEFAULT '{}',
  payload jsonb NOT NULL,
  search_names text GENERATED ALWAYS AS (lower(name || ' ' || registry_immutable_join(aliases, ' '))) STORED,
  search_document text NOT NULL DEFAULT '',
  search_vector tsvector GENERATED ALWAYS AS (to_tsvector('english', search_document)) STORED,
  supersedes_id bigint REFERENCES registry_entries(id),
  superseded_by bigint REFERENCES registry_entries(id),
  mentioned_at bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_id, entity_type, entity_id, version),
  CHECK ((version = 1 AND supersedes_id IS NULL) OR (version > 1 AND supersedes_id IS NOT NULL))
);
CREATE INDEX registry_entries_game_idx ON registry_entries(session_id, entity_type, entity_id);
CREATE INDEX registry_entries_trigram_idx ON registry_entries USING gin (search_names gin_trgm_ops);
CREATE INDEX registry_entries_search_idx ON registry_entries USING gin (search_vector);

CREATE TABLE registry_facts (
  id bigserial PRIMARY KEY,
  entry_id bigint NOT NULL REFERENCES registry_entries(id) ON DELETE CASCADE,
  fact text NOT NULL CHECK (length(fact) <= 160),
  supersedes_id bigint REFERENCES registry_facts(id),
  superseded_by bigint REFERENCES registry_facts(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (entry_id, fact)
);
CREATE INDEX registry_facts_search_idx ON registry_facts USING gin (to_tsvector('english', fact));
CREATE INDEX registry_facts_current_idx ON registry_facts(entry_id) WHERE superseded_by IS NULL;

CREATE TABLE scene_summaries (
  id bigserial PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  scene_id text NOT NULL,
  summary text NOT NULL CHECK (length(summary) <= 1200),
  created_at timestamptz NOT NULL DEFAULT now(),
  search_vector tsvector GENERATED ALWAYS AS (to_tsvector('english', summary)) STORED
);
CREATE INDEX scene_summaries_search_idx ON scene_summaries USING gin(search_vector);
