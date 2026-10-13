ALTER TABLE moderation_log
  DROP CONSTRAINT moderation_log_fail_closed_row_check;

ALTER TABLE moderation_log
  ADD CONSTRAINT moderation_log_fail_closed_row_check
  CHECK (fail_closed_row IN ('hard-floor','tier','boundaries'));
