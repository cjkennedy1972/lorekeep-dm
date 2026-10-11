import { readFileSync } from 'node:fs';
export const up = (pgm) => {
  pgm.sql(
    readFileSync(new URL('./0020_mature_tier.sql', import.meta.url), 'utf8'),
  );
};
export const down = (pgm) => {
  pgm.sql(
    'ALTER TABLE sessions DROP COLUMN content_tier, DROP COLUMN moderation_verified;',
  );
};
