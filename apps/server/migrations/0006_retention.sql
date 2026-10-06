CREATE TABLE retention_state (
 id text PRIMARY KEY, last_completed_at timestamptz NOT NULL
);
CREATE TABLE legal_holds (
 kind text NOT NULL CHECK (kind IN ('account','export','session')), item_id text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (kind, item_id)
);
CREATE TABLE retention_audit (
 id bigserial PRIMARY KEY, ts timestamptz NOT NULL DEFAULT now(),
 job text NOT NULL, item_kind text NOT NULL, item_id text NOT NULL, action text NOT NULL
);
-- Sanctioned deletions of the append-only event log (ADR-017), same mechanism as redact_event.
CREATE FUNCTION purge_expired_events(p_before timestamptz) RETURNS bigint
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
CREATE FUNCTION purge_session(p_session_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE prior text;
BEGIN
 prior := current_setting('lorekeep.redacting_event', true);
 PERFORM set_config('lorekeep.redacting_event', 'on', true);
 DELETE FROM public.sessions WHERE id = p_session_id;
 PERFORM set_config('lorekeep.redacting_event', COALESCE(prior, 'off'), true);
END $$;
REVOKE ALL ON FUNCTION purge_expired_events(timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION purge_session(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION purge_expired_events(timestamptz) TO lorekeep_redaction;
GRANT EXECUTE ON FUNCTION purge_session(uuid) TO lorekeep_redaction;
