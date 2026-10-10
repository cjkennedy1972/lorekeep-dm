CREATE FUNCTION purge_archived_session(p_session_id uuid, p_archived_before timestamptz) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE prior text; n bigint;
BEGIN
 prior := current_setting('lorekeep.redacting_event', true);
 PERFORM set_config('lorekeep.redacting_event', 'on', true);
 DELETE FROM public.sessions WHERE id = p_session_id AND status = 'archived' AND archived_at < p_archived_before;
 GET DIAGNOSTICS n = ROW_COUNT;
 PERFORM set_config('lorekeep.redacting_event', COALESCE(prior, 'off'), true);
 RETURN n > 0;
END $$;
REVOKE ALL ON FUNCTION purge_archived_session(uuid, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION purge_archived_session(uuid, timestamptz) TO lorekeep_redaction;
