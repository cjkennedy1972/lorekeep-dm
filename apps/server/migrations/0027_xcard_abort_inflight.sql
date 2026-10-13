ALTER TABLE sessions
 ADD COLUMN xcard_abort_inflight boolean NOT NULL DEFAULT false;
