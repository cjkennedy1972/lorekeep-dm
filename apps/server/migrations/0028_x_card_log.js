import { readFileSync } from 'node:fs';
export const up = (pgm) => {
  pgm.sql(
    readFileSync(new URL('./0028_x_card_log.sql', import.meta.url), 'utf8'),
  );
};
export const down = (pgm) => {
  pgm.sql('DROP TABLE x_card_log;');
};
