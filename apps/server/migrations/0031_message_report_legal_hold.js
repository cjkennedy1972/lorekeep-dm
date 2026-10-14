import { readFileSync } from 'node:fs';
export const up = (pgm) =>
  pgm.sql(
    readFileSync(
      new URL('./0031_message_report_legal_hold.sql', import.meta.url),
      'utf8',
    ),
  );
export const down = (pgm) =>
  pgm.sql('ALTER TABLE message_reports DROP COLUMN legal_hold;');
