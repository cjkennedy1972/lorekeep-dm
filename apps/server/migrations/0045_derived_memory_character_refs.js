import { readFileSync } from 'node:fs';

export const up = (pgm) =>
  pgm.sql(
    readFileSync(
      new URL('./0045_derived_memory_character_refs.sql', import.meta.url),
      'utf8',
    ),
  );

// This migration is additive. Rollback is intentionally a no-op so reverting
// application code cannot destroy reference/deletion state.
export const down = () => {};
