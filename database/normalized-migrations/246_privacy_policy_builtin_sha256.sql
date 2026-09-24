BEGIN;
SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '5s';

-- Runtime sessions use search_path=pg_catalog. The original content check called
-- unqualified pgcrypto digest(), so staff draft/publish failed even when the
-- customer read path was healthy. Builtin sha256() matches the UTF-8 digest
-- already stored for any existing row.
DO $$
DECLARE constraint_name text;
BEGIN
  SELECT constraint_row.conname INTO constraint_name
  FROM pg_constraint constraint_row
  JOIN pg_class relation ON relation.oid = constraint_row.conrelid
  JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
  WHERE namespace.nspname = 'mbox'
    AND relation.relname = 'privacy_policy_releases'
    AND constraint_row.contype = 'c'
    AND pg_get_constraintdef(constraint_row.oid) ILIKE '%digest(%';
  IF constraint_name IS NULL THEN
    RAISE EXCEPTION 'privacy policy digest check is missing';
  END IF;
  EXECUTE format(
    'ALTER TABLE mbox.privacy_policy_releases DROP CONSTRAINT %I',
    constraint_name
  );
END $$;

ALTER TABLE mbox.privacy_policy_releases
  ADD CONSTRAINT privacy_policy_releases_content_sha256_ck
  CHECK (
    content_sha256 ~ '^[0-9a-f]{64}$'
    AND content_sha256 = encode(sha256(convert_to(content_markdown, 'UTF8')), 'hex')
  );

UPDATE mbox.normalized_schema_metadata SET schema_version='246',updated_at=clock_timestamp()
WHERE singleton=true AND schema_flavor='normalized-core-v1';
COMMIT;
