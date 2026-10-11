ALTER TABLE sessions
 ADD COLUMN host_tier_cap text CHECK (host_tier_cap IN ('family','standard'));
