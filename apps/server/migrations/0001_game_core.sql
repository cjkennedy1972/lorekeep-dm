CREATE TABLE sessions (
 id uuid PRIMARY KEY, owner_account_id uuid NOT NULL, status text NOT NULL DEFAULT 'active',
 created_at timestamptz NOT NULL DEFAULT now(), last_active_at timestamptz NOT NULL DEFAULT now(), archived_at timestamptz
);
CREATE TABLE events (
 session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
 seq bigint NOT NULL, turn_id uuid NOT NULL, type text NOT NULL, payload jsonb NOT NULL,
 ts timestamptz NOT NULL DEFAULT now(), expires_at timestamptz,
 PRIMARY KEY (session_id, seq)
);
CREATE TABLE snapshots (
 session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
 seq bigint NOT NULL, state jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (session_id, seq)
);
CREATE TABLE session_lease (
 session_id uuid PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
 node_id text NOT NULL, expires_at timestamptz NOT NULL
);
CREATE FUNCTION block_event_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF current_user = (SELECT relowner::regrole::text FROM pg_class WHERE oid = TG_RELID) AND current_setting('lorekeep.redacting_event', true) = 'on' THEN RETURN COALESCE(NEW, OLD); END IF;
 RAISE EXCEPTION 'events are append-only';
END $$;
CREATE TRIGGER events_append_only BEFORE UPDATE OR DELETE ON events FOR EACH ROW EXECUTE FUNCTION block_event_mutation();
CREATE FUNCTION redact_event(p_session_id uuid, p_seq bigint, p_payload jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE prior text;
BEGIN
 prior := current_setting('lorekeep.redacting_event', true);
 PERFORM set_config('lorekeep.redacting_event', 'on', true);
 UPDATE public.events SET payload = p_payload WHERE session_id = p_session_id AND seq = p_seq;
 PERFORM set_config('lorekeep.redacting_event', COALESCE(prior, 'off'), true);
END $$;
REVOKE ALL ON FUNCTION redact_event(uuid,bigint,jsonb) FROM PUBLIC;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'lorekeep_redaction') THEN CREATE ROLE lorekeep_redaction NOLOGIN; END IF; END $$;
GRANT EXECUTE ON FUNCTION redact_event(uuid,bigint,jsonb) TO lorekeep_redaction;
