BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '15s';

-- Alipay phone ciphertext is AES-128-CBC with a fixed key and a zero IV over a
-- fixed plaintext, so one phone number always produces the same ciphertext.
-- Historical rows stored sha256('alipay-phone:' || sha256(ciphertext)) in the
-- store-wide unique authorization reference. That value is a phone proof, not
-- a one-time authorization nonce, and the append-only action table cannot
-- accept a second copy. New attempts keep a distinct authorization reference.
-- This column remembers the stable proof so a later enroll can reclaim the
-- same phone, including after the previous contact was revoked or disposed.
-- It is a keyed digest, never a phone number, and it is intentionally not
-- unique. One-time WeChat authorization codes stay unique on
-- customer_verified_contact_actions_authorization_reference_uq.

ALTER TABLE mbox.customer_verified_contacts
  ADD COLUMN repeatable_proof_sha256 char(64);

ALTER TABLE mbox.customer_verified_contacts
  ADD CONSTRAINT customer_verified_contacts_repeatable_proof_sha256_ck
  CHECK (repeatable_proof_sha256 IS NULL OR repeatable_proof_sha256 ~ '^[0-9a-f]{64}$');

CREATE INDEX customer_verified_contacts_repeatable_proof_idx
  ON mbox.customer_verified_contacts (tenant_id, store_id, repeatable_proof_sha256)
  WHERE repeatable_proof_sha256 IS NOT NULL;

-- 079 granted table-level SELECT and INSERT to mbox_runtime. Repeat the column
-- grants so a rebuilt privilege set still lets the enroll transaction write and
-- read the digest. Do not grant UPDATE: the digest is insert-only evidence.
GRANT SELECT (repeatable_proof_sha256), INSERT (repeatable_proof_sha256)
  ON TABLE mbox.customer_verified_contacts TO mbox_runtime;

-- Reactivating a revoked phone must clear revoked_at. The lifecycle check then
-- also requires both revocation actors to be null. 095 granted revoked_at;
-- 247 granted processing_status and revocation_reason_code. These two actor
-- columns were still missing, so a direct reactivation would be denied.
GRANT UPDATE (revoked_by_customer_id, revoked_by_employee_id)
  ON TABLE mbox.customer_verified_contacts TO mbox_runtime;

CREATE OR REPLACE FUNCTION mbox.protect_customer_verified_contact_version()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('app.verified_contact_legacy_replay',true)=OLD.id::text THEN
    RETURN OLD;
  END IF;
  IF current_setting('app.verified_contact_merge_reconciliation',true)=OLD.id::text
    AND OLD.supersedes_contact_id IS NULL AND NEW.supersedes_contact_id IS NOT NULL
    AND ROW(OLD.tenant_id,OLD.store_id,OLD.customer_id,OLD.contact_type,OLD.public_id,
      OLD.contact_hash,OLD.encrypted_value,OLD.encryption_key_version,OLD.masked_value,
      OLD.verification_source,OLD.provider_reference_sha256,OLD.repeatable_proof_sha256,
      OLD.verified_by_customer_id,
      OLD.verified_by_employee_id,OLD.verified_at,OLD.revoked_at,OLD.created_at,
      OLD.processing_status,OLD.revoked_by_customer_id,OLD.revoked_by_employee_id,
      OLD.revocation_reason_code,OLD.contact_encryption_key_id,OLD.disposed_at,
      OLD.disposition_policy_version_id)
      IS NOT DISTINCT FROM
      ROW(NEW.tenant_id,NEW.store_id,NEW.customer_id,NEW.contact_type,NEW.public_id,
      NEW.contact_hash,NEW.encrypted_value,NEW.encryption_key_version,NEW.masked_value,
      NEW.verification_source,NEW.provider_reference_sha256,NEW.repeatable_proof_sha256,
      NEW.verified_by_customer_id,
      NEW.verified_by_employee_id,NEW.verified_at,NEW.revoked_at,NEW.created_at,
      NEW.processing_status,NEW.revoked_by_customer_id,NEW.revoked_by_employee_id,
      NEW.revocation_reason_code,NEW.contact_encryption_key_id,NEW.disposed_at,
      NEW.disposition_policy_version_id) THEN
    RETURN NEW;
  END IF;
  IF OLD.tenant_id<>NEW.tenant_id OR OLD.store_id<>NEW.store_id
    OR OLD.customer_id<>NEW.customer_id OR OLD.contact_type<>NEW.contact_type
    OR OLD.public_id<>NEW.public_id OR OLD.supersedes_contact_id IS DISTINCT FROM NEW.supersedes_contact_id
    OR OLD.verification_source<>NEW.verification_source
    OR OLD.provider_reference_sha256 IS DISTINCT FROM NEW.provider_reference_sha256
    OR OLD.repeatable_proof_sha256 IS DISTINCT FROM NEW.repeatable_proof_sha256
    OR OLD.verified_by_customer_id IS DISTINCT FROM NEW.verified_by_customer_id
    OR OLD.verified_by_employee_id IS DISTINCT FROM NEW.verified_by_employee_id
    OR OLD.verified_at<>NEW.verified_at OR OLD.created_at<>NEW.created_at THEN
    RAISE EXCEPTION 'verified contact identity and verification evidence are immutable' USING ERRCODE='23514';
  END IF;
  IF OLD.processing_status='revoked' AND NEW.processing_status='active'
    AND current_setting('app.verified_contact_reauthorization',true)=OLD.id::text THEN
    RETURN NEW;
  END IF;
  IF OLD.processing_status='disposed'
    OR (OLD.processing_status='active' AND NEW.processing_status<>'revoked')
    OR (OLD.processing_status='revoked' AND NEW.processing_status<>'disposed') THEN
    RAISE EXCEPTION 'verified contact lifecycle is invalid' USING ERRCODE='23514';
  END IF;
  IF NEW.processing_status='disposed' AND current_setting('app.personal_contact_disposition',true)
      IS DISTINCT FROM OLD.id::text THEN
    RAISE EXCEPTION 'verified contact disposal must use the governed database function' USING ERRCODE='42501';
  END IF;
  IF NEW.processing_status<>'disposed' AND (
    OLD.contact_hash IS DISTINCT FROM NEW.contact_hash
    OR OLD.encrypted_value IS DISTINCT FROM NEW.encrypted_value
    OR OLD.encryption_key_version IS DISTINCT FROM NEW.encryption_key_version
    OR OLD.contact_encryption_key_id IS DISTINCT FROM NEW.contact_encryption_key_id
    OR OLD.masked_value IS DISTINCT FROM NEW.masked_value
  ) THEN
    RAISE EXCEPTION 'verified contact value cannot be overwritten or reactivated' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

COMMENT ON COLUMN mbox.customer_verified_contacts.repeatable_proof_sha256 IS
  'Stable digest of a repeatable phone proof such as Alipay ciphertext. Not a phone number. One-time WeChat codes leave this null and stay unique on the authorization action.';

UPDATE mbox.normalized_schema_metadata
SET schema_version='251', updated_at=clock_timestamp()
WHERE singleton=true AND schema_flavor='normalized-core-v1';
COMMIT;
