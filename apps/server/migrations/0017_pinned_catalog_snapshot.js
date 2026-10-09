export const up = (pgm) =>
  pgm.sql(`
    CREATE TABLE catalog_snapshots (
      catalog_version text PRIMARY KEY,
      entries jsonb NOT NULL CHECK (jsonb_typeof(entries) = 'array'),
      created_at timestamptz NOT NULL DEFAULT now()
    );
  `);
export const down = (pgm) => pgm.sql('DROP TABLE catalog_snapshots;');
