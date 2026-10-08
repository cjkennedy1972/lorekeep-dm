import { readFileSync } from 'node:fs';
export const up = (pgm) =>
  pgm.sql(
    readFileSync(
      new URL('./0011_operator_endpoints.sql', import.meta.url),
      'utf8',
    ),
  );
export const down = (pgm) =>
  pgm.sql('DROP TABLE operator_endpoint_audit; DROP TABLE operator_endpoints;');
