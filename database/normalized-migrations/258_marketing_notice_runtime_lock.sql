BEGIN;
-- Decision and customer-consent triggers use SELECT ... FOR UPDATE on the
-- immutable notice. PostgreSQL requires UPDATE on at least one column for that
-- row lock; SELECT/INSERT alone fail for the real restricted runtime login.
-- Only the identity column is granted. The existing append_only trigger rejects
-- every UPDATE (including no-op identity writes) and DELETE remains ungranted.
GRANT UPDATE(id) ON mbox.marketing_notice_versions TO mbox_runtime;
COMMIT;
