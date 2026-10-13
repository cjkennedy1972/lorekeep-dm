ALTER TABLE accounts
  ADD COLUMN content_lines text[] NOT NULL DEFAULT '{}',
  ADD COLUMN content_veils text[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN accounts.content_lines IS
  'Account-private hard content boundaries; unioned across seated players for shared narration.';
COMMENT ON COLUMN accounts.content_veils IS
  'Account-private fade-out content boundaries; unioned across seated players for shared narration.';
