-- Tickets are short-lived; drop any outstanding ones so the new column can be NOT NULL.
DELETE FROM ws_tickets;
ALTER TABLE ws_tickets ADD COLUMN auth_token_hash text NOT NULL REFERENCES auth_sessions(token_hash) ON DELETE CASCADE;
CREATE INDEX ws_tickets_auth_token_hash_idx ON ws_tickets(auth_token_hash);
