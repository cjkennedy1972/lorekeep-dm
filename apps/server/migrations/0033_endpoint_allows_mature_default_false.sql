ALTER TABLE sessions ALTER COLUMN endpoint_allows_mature SET DEFAULT false;
UPDATE sessions SET endpoint_allows_mature = false WHERE endpoint_allows_mature;
