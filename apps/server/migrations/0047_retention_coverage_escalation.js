import { readFileSync } from 'node:fs';

export const up = (pgm) =>
  pgm.sql(
    readFileSync(
      new URL('./0047_retention_coverage_escalation.sql', import.meta.url),
      'utf8',
    ),
  );

export const down = () => {};
