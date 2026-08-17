BEGIN;

-- Activity contacts are operational personal data, not a free-form snapshot.
-- Existing rows must already have been protected by the application before
-- this migration can be applied; validation deliberately fails closed rather
-- than fabricating ciphertext or retaining plaintext.
ALTER TABLE mbox.community_activity_registrations
  ALTER COLUMN contact_snapshot DROP DEFAULT,
  ADD CONSTRAINT community_activity_registrations_contact_protected_ck CHECK (
    jsonb_typeof(contact_snapshot) = 'object'
    AND contact_snapshot ?& ARRAY[
      'contactType', 'contactHash', 'encryptedContact',
      'encryptionKeyId', 'maskedContact', 'source'
    ]
    AND contact_snapshot - ARRAY[
      'contactType', 'contactHash', 'encryptedContact',
      'encryptionKeyId', 'maskedContact', 'source'
    ] = '{}'::jsonb
    AND contact_snapshot->>'contactType' IN ('phone', 'wechat', 'other')
    AND contact_snapshot->>'contactHash' ~ '^[0-9a-f]{64}$'
    AND length(contact_snapshot->>'encryptedContact') BETWEEN 24 AND 4096
    AND length(btrim(contact_snapshot->>'encryptionKeyId')) BETWEEN 3 AND 128
    AND length(btrim(contact_snapshot->>'maskedContact')) BETWEEN 3 AND 64
    AND contact_snapshot->>'source' = 'mini_program'
  ) NOT VALID;

ALTER TABLE mbox.community_activity_registrations
  VALIDATE CONSTRAINT community_activity_registrations_contact_protected_ck;

COMMENT ON COLUMN mbox.community_activity_registrations.contact_snapshot IS
  'Protected contact envelope only: ciphertext, hash, key id, masked value, type and trusted source. Plaintext and arbitrary keys are forbidden.';

UPDATE mbox.normalized_schema_metadata
SET schema_version = '055', updated_at = clock_timestamp()
WHERE singleton = true AND schema_flavor = 'normalized-core-v1';

COMMIT;
