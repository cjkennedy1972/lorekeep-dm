/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export const up = (pgm) => {
  pgm.addColumn('endpoint_usage', {
    cache_write_tokens: {
      type: 'integer',
      notNull: true,
      default: 0,
      check: 'cache_write_tokens >= 0',
    },
  });
};
/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export const down = (pgm) =>
  pgm.dropColumn('endpoint_usage', 'cache_write_tokens');
