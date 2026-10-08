import { readFileSync } from 'node:fs';
export const up = (pgm) =>
  pgm.sql(
    readFileSync(new URL('./0007_srd_text.sql', import.meta.url), 'utf8'),
  );
export const down = (pgm) =>
  pgm.sql('DROP TABLE srd_text_chunks, srd_text_metadata;');
