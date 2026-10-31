CREATE OR REPLACE FUNCTION serialize_session_legal_hold() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  prior_kind text;
  prior_item text;
  next_kind text;
  next_item text;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    prior_kind := OLD.kind;
    prior_item := OLD.item_id;
  END IF;
  IF TG_OP <> 'DELETE' THEN
    next_kind := NEW.kind;
    next_item := NEW.item_id;
  END IF;
  PERFORM s.id
    FROM sessions s
   WHERE (prior_kind = 'session' AND s.id::text = prior_item)
      OR (prior_kind = 'account' AND (
            s.owner_account_id::text = prior_item OR EXISTS (
              SELECT 1 FROM session_seat_characters b
               WHERE b.session_id=s.id AND b.account_id::text=prior_item)))
      OR (prior_kind = 'export' AND EXISTS (
            SELECT 1 FROM export_jobs e
             WHERE e.id::text = prior_item
               AND (e.account_id = s.owner_account_id OR EXISTS (
                 SELECT 1 FROM session_seat_characters b
                  WHERE b.session_id=s.id AND b.account_id=e.account_id))))
      OR (next_kind = 'session' AND s.id::text = next_item)
      OR (next_kind = 'account' AND (
            s.owner_account_id::text = next_item OR EXISTS (
              SELECT 1 FROM session_seat_characters b
               WHERE b.session_id=s.id AND b.account_id::text=next_item)))
      OR (next_kind = 'export' AND EXISTS (
            SELECT 1 FROM export_jobs e
             WHERE e.id::text = next_item
               AND (e.account_id = s.owner_account_id OR EXISTS (
                 SELECT 1 FROM session_seat_characters b
                  WHERE b.session_id=s.id AND b.account_id=e.account_id))))
   ORDER BY s.id
   FOR UPDATE;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
