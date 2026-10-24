-- Legacy retention and expiry workflows may contain unbound ticket rows.
-- Redemption remains fail-closed unless the exact ticket seat is currently joined.
ALTER TABLE ws_tickets ALTER COLUMN seat_id DROP NOT NULL;
