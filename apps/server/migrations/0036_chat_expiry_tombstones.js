import { readFileSync } from 'node:fs';

export const up = (pgm) =>
  pgm.sql(
    readFileSync(
      new URL('./0036_chat_expiry_tombstones.sql', import.meta.url),
      'utf8',
    ),
  );

export const down = (pgm) =>
  pgm.sql(`
    CREATE OR REPLACE FUNCTION purge_expired_events(p_before timestamptz) RETURNS bigint
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
    DECLARE prior text; n bigint;
    BEGIN
      prior := current_setting('lorekeep.redacting_event', true);
      PERFORM set_config('lorekeep.redacting_event', 'on', true);
      DELETE FROM public.events e WHERE e.expires_at IS NOT NULL AND e.expires_at < p_before
        AND NOT EXISTS (SELECT 1 FROM public.legal_holds h WHERE h.kind='session' AND h.item_id = e.session_id::text);
      GET DIAGNOSTICS n = ROW_COUNT;
      PERFORM set_config('lorekeep.redacting_event', COALESCE(prior, 'off'), true);
      RETURN n;
    END $$;
  `);
