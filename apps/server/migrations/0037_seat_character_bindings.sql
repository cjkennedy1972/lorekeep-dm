CREATE TABLE IF NOT EXISTS account_characters (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  character jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, id)
);

CREATE TABLE IF NOT EXISTS session_seat_characters (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  seat_id uuid NOT NULL,
  account_id uuid REFERENCES accounts(id) ON DELETE SET NULL,
  character_id uuid,
  character_revision integer,
  character_snapshot jsonb NOT NULL,
  binding_status text NOT NULL DEFAULT 'active'
    CHECK (binding_status IN ('active', 'released', 'redacted')),
  bound_at timestamptz NOT NULL DEFAULT now(),
  unbound_at timestamptz,
  FOREIGN KEY (account_id, character_id) REFERENCES account_characters(account_id, id) ON DELETE SET NULL (character_id),
  CHECK ((binding_status = 'active' AND account_id IS NOT NULL AND character_id IS NOT NULL AND unbound_at IS NULL)
      OR binding_status <> 'active'),
  CHECK (binding_status <> 'redacted' OR (account_id IS NULL AND character_id IS NULL AND character_revision IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS session_seat_characters_one_active_per_seat
  ON session_seat_characters(session_id, seat_id) WHERE binding_status='active';
CREATE UNIQUE INDEX IF NOT EXISTS session_seat_characters_one_active_per_character
  ON session_seat_characters(session_id, character_id) WHERE binding_status='active';
CREATE INDEX IF NOT EXISTS session_seat_characters_account_idx ON session_seat_characters(account_id) WHERE account_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS session_seat_characters_character_idx ON session_seat_characters(character_id) WHERE character_id IS NOT NULL;

CREATE OR REPLACE FUNCTION block_bound_character_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM session_seat_characters
    WHERE account_id=OLD.account_id AND character_id=OLD.id AND binding_status='active'
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE='23503',
      CONSTRAINT='session_seat_characters_active_character_fkey',
      MESSAGE='character is blocked while an active seat binding exists';
  END IF;
  RETURN OLD;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname='account_characters_block_active_delete'
      AND tgrelid='account_characters'::regclass
  ) THEN
    CREATE TRIGGER account_characters_block_active_delete
      BEFORE DELETE ON account_characters
      FOR EACH ROW EXECUTE FUNCTION block_bound_character_delete();
  END IF;
END $$;
