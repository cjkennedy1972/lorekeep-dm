import { readFileSync } from 'node:fs';
export const up = (pgm) =>
  pgm.sql(
    readFileSync(
      new URL('./0012_endpoint_tool_schema_keywords.sql', import.meta.url),
      'utf8',
    ),
  );
export const down = (pgm) =>
  pgm.dropColumn('operator_endpoints', 'unsupported_tool_schema_keywords');
