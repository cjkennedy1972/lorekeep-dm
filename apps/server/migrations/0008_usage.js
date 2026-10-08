import { readFileSync } from 'node:fs';
export const up = (pgm) => {
  pgm.sql(readFileSync(new URL('./0008_usage.sql', import.meta.url), 'utf8'));
};
export const down = (pgm) => {
  pgm.sql('DROP TABLE endpoint_usage;');
};
