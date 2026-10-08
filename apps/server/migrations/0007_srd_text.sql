CREATE TABLE srd_text_metadata (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  attribution text NOT NULL,
  source_url text NOT NULL,
  source_sha256 text NOT NULL,
  regenerated_by text NOT NULL
);
CREATE TABLE srd_text_chunks (
  id text PRIMARY KEY,
  section_path text NOT NULL,
  text text NOT NULL,
  srd_page integer NOT NULL CHECK (srd_page > 0),
  search_vector tsvector GENERATED ALWAYS AS (to_tsvector('english', section_path || ' ' || text)) STORED
);
CREATE INDEX srd_text_chunks_search_idx ON srd_text_chunks USING gin(search_vector);
