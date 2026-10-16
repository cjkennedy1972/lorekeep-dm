import { readFileSync } from 'node:fs';
export const up = (pgm) => {
  pgm.sql(
    readFileSync(
      new URL('./0034_mature_endpoint_attestation.sql', import.meta.url),
      'utf8',
    ),
  );
};
export const down = (pgm) => {
  pgm.sql(
    'UPDATE sessions SET endpoint_allows_mature = false, moderation_verified = false;',
  );
  pgm.sql(
    'ALTER TABLE sessions DROP COLUMN endpoint_mature_fingerprint, DROP COLUMN moderation_mature_fingerprint;',
  );
  // Keep the audit action check widened: dropping it could invalidate retained
  // mature_enabled/mature_disabled history, and older code tolerates extra values.
};
