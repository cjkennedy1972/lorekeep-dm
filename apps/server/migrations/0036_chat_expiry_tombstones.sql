CREATE OR REPLACE FUNCTION purge_expired_events(p_before timestamptz) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE prior text; n bigint; tombstoned bigint;
BEGIN
 prior := current_setting('lorekeep.redacting_event', true);
 PERFORM set_config('lorekeep.redacting_event', 'on', true);
 UPDATE public.events e
   SET payload = '{}'::jsonb, expires_at = NULL
   WHERE e.expires_at IS NOT NULL AND e.expires_at < p_before
     AND e.type IN ('chat.committed','chat.rejected')
     AND NOT EXISTS (
       SELECT 1 FROM public.legal_holds h
       WHERE h.kind='session' AND h.item_id = e.session_id::text
     );
 GET DIAGNOSTICS tombstoned = ROW_COUNT;
 DELETE FROM public.events e WHERE e.expires_at IS NOT NULL AND e.expires_at < p_before
   AND NOT EXISTS (SELECT 1 FROM public.legal_holds h WHERE h.kind='session' AND h.item_id = e.session_id::text);
 GET DIAGNOSTICS n = ROW_COUNT;
 PERFORM set_config('lorekeep.redacting_event', COALESCE(prior, 'off'), true);
 RETURN n + tombstoned;
END $$;
