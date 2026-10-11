import { readFileSync } from 'node:fs';
export const up = (pgm) => {
  pgm.sql(
    readFileSync(
      new URL('./0021_message_reports.sql', import.meta.url),
      'utf8',
    ),
  );
};
export const down = (pgm) => {
  pgm.sql('DROP TABLE message_report_audit; DROP TABLE message_reports;');
};
