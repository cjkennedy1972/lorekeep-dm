CREATE FUNCTION serialize_session_legal_hold() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  prior_item text;
  next_item text;
BEGIN
  IF TG_OP <> 'INSERT' AND OLD.kind = 'session' THEN
    prior_item := OLD.item_id;
  END IF;
  IF TG_OP <> 'DELETE' AND NEW.kind = 'session' THEN
    next_item := NEW.item_id;
  END IF;
  PERFORM s.id
    FROM sessions s
   WHERE s.id::text = ANY(ARRAY[prior_item, next_item])
   ORDER BY s.id
   FOR UPDATE;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER legal_holds_serialize_session_mutations
BEFORE INSERT OR UPDATE OR DELETE ON legal_holds
FOR EACH ROW EXECUTE FUNCTION serialize_session_legal_hold();
