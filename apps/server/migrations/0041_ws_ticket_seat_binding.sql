-- Tickets identify one authenticated seat connection.
DELETE FROM ws_tickets;
ALTER TABLE ws_tickets ADD COLUMN seat_id uuid NOT NULL;
