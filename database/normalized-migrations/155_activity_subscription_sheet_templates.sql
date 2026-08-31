BEGIN;

-- Superhigh activity subscribe sheet needs two additional member-service types:
-- 演出即将开始提醒 + 活动时间变更.  Authorize now; dedicated send producers can follow.

DO $$
DECLARE
  constraint_name text;
BEGIN
  FOR constraint_name IN
    SELECT con.conname
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid=con.conrelid
    JOIN pg_namespace nsp ON nsp.oid=rel.relnamespace
    WHERE nsp.nspname='mbox'
      AND rel.relname='wechat_member_service_notification_policies'
      AND con.contype='c'
      AND (
        pg_get_constraintdef(con.oid) LIKE '%activity_registration_confirmed%'
        OR pg_get_constraintdef(con.oid) LIKE '%authorization_context%'
        OR pg_get_constraintdef(con.oid) LIKE '%activity_registration%'
      )
      AND con.conname NOT LIKE '%no_published_overlap%'
  LOOP
    EXECUTE format(
      'ALTER TABLE mbox.wechat_member_service_notification_policies DROP CONSTRAINT %I',
      constraint_name
    );
  END LOOP;

  FOR constraint_name IN
    SELECT con.conname
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid=con.conrelid
    JOIN pg_namespace nsp ON nsp.oid=rel.relnamespace
    WHERE nsp.nspname='mbox'
      AND rel.relname='wechat_member_service_notification_jobs'
      AND con.contype='c'
      AND (
        pg_get_constraintdef(con.oid) LIKE '%activity_registration%'
        OR pg_get_constraintdef(con.oid) LIKE '%membership_tier_event%'
      )
      AND (
        pg_get_constraintdef(con.oid) LIKE '%notification_type%'
        OR pg_get_constraintdef(con.oid) LIKE '%source_type%'
      )
  LOOP
    EXECUTE format(
      'ALTER TABLE mbox.wechat_member_service_notification_jobs DROP CONSTRAINT %I',
      constraint_name
    );
  END LOOP;
END $$;

ALTER TABLE mbox.wechat_member_service_notification_policies
  DROP CONSTRAINT IF EXISTS wechat_member_service_notification_policies_notification_type_check;
ALTER TABLE mbox.wechat_member_service_notification_policies
  DROP CONSTRAINT IF EXISTS wechat_member_service_notification_policies_authorization_context_check;
ALTER TABLE mbox.wechat_member_service_notification_policies
  DROP CONSTRAINT IF EXISTS wechat_member_service_notification_policies_type_context_check;
ALTER TABLE mbox.wechat_member_service_notification_jobs
  DROP CONSTRAINT IF EXISTS wechat_member_service_notification_jobs_source_type_check;
ALTER TABLE mbox.wechat_member_service_notification_jobs
  DROP CONSTRAINT IF EXISTS wechat_member_service_notification_jobs_type_source_check;

ALTER TABLE mbox.wechat_member_service_notification_policies
  ADD CONSTRAINT wechat_member_service_notification_policies_notification_type_check
  CHECK (notification_type IN (
    'activity_registration_confirmed',
    'activity_performance_starting',
    'activity_schedule_changed',
    'member_benefit_issued',
    'membership_tier_changed'
  ));

ALTER TABLE mbox.wechat_member_service_notification_policies
  ADD CONSTRAINT wechat_member_service_notification_policies_authorization_context_check
  CHECK (authorization_context IN (
    'activity_registration',
    'activity_performance',
    'activity_schedule',
    'member_benefit',
    'membership_tier'
  ));

ALTER TABLE mbox.wechat_member_service_notification_policies
  ADD CONSTRAINT wechat_member_service_notification_policies_type_context_check
  CHECK (
    (notification_type='activity_registration_confirmed' AND authorization_context='activity_registration')
    OR (notification_type='activity_performance_starting' AND authorization_context='activity_performance')
    OR (notification_type='activity_schedule_changed' AND authorization_context='activity_schedule')
    OR (notification_type='member_benefit_issued' AND authorization_context='member_benefit')
    OR (notification_type='membership_tier_changed' AND authorization_context='membership_tier')
  );

ALTER TABLE mbox.wechat_member_service_notification_jobs
  ADD CONSTRAINT wechat_member_service_notification_jobs_source_type_check
  CHECK (source_type IN (
    'activity_registration',
    'activity_performance',
    'activity_schedule',
    'benefit',
    'membership_tier_event'
  ));

ALTER TABLE mbox.wechat_member_service_notification_jobs
  ADD CONSTRAINT wechat_member_service_notification_jobs_type_source_check
  CHECK (
    (notification_type='activity_registration_confirmed' AND source_type='activity_registration')
    OR (notification_type='activity_performance_starting' AND source_type='activity_performance')
    OR (notification_type='activity_schedule_changed' AND source_type='activity_schedule')
    OR (notification_type='member_benefit_issued' AND source_type='benefit')
    OR (notification_type='membership_tier_changed' AND source_type='membership_tier_event')
  );

COMMIT;
