BEGIN;
-- Anonymous public sessions cannot authenticate a platform. Preserve them as
-- online bookings rather than falsely attributing Alipay/web visitors to WeChat.
-- Existing rows keep their recorded source; no unsupported historical backfill.
ALTER TABLE mbox.reservations DROP CONSTRAINT reservations_source_check;
ALTER TABLE mbox.reservations ADD CONSTRAINT reservations_source_check
  CHECK (source IN ('wechat', 'online', 'phone', 'walk_in', 'employee', 'integration'));
ALTER TABLE mbox.waitlist_entries DROP CONSTRAINT waitlist_entries_source_check;
ALTER TABLE mbox.waitlist_entries ADD CONSTRAINT waitlist_entries_source_check
  CHECK (source IN ('wechat', 'online', 'phone', 'walk_in', 'employee'));
COMMIT;
