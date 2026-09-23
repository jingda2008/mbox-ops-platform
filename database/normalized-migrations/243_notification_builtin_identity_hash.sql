BEGIN;
SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '5s';

-- Equivalent SHA256 over UTF8, independent of pgcrypto extension placement.
-- Preserve invoker rights, every ownership predicate and all existing grants.

CREATE OR REPLACE FUNCTION mbox.validate_wechat_notification_authorization_owner()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM mbox.wechat_identities identity
    JOIN mbox.customer_identities customer_identity
      ON customer_identity.tenant_id=identity.tenant_id
     AND customer_identity.store_id=identity.store_id
     AND customer_identity.identity_kind='wechat'
     AND customer_identity.identity_hash=encode(sha256(convert_to('wechat:'||identity.principal_id,'UTF8')),'hex')
     AND customer_identity.status='active'
    WHERE identity.tenant_id=NEW.tenant_id
      AND identity.store_id=NEW.store_id
      AND identity.external_identity_id=NEW.identity_external_id
      AND identity.channel='mini_program'
      AND identity.revoked_at IS NULL
      AND customer_identity.customer_id=NEW.customer_id
      AND (identity.member_id IS NULL OR identity.member_id=NEW.membership_id)
  ) THEN
    RAISE EXCEPTION 'WeChat notification authorization identity does not belong to customer';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION mbox.validate_reservation_performance_notification_owner()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS(
    SELECT 1
    FROM mbox.reservations reservation
    JOIN mbox.wechat_identities identity
      ON identity.tenant_id=reservation.tenant_id AND identity.store_id=reservation.store_id
     AND identity.external_identity_id=NEW.identity_external_id
     AND identity.channel='mini_program' AND identity.revoked_at IS NULL
    JOIN mbox.customer_identities customer_identity
      ON customer_identity.tenant_id=identity.tenant_id
     AND customer_identity.store_id=identity.store_id
     AND customer_identity.identity_kind='wechat'
     AND customer_identity.identity_hash=encode(
       sha256(convert_to('wechat:'||identity.principal_id,'UTF8')),'hex'
     )
     AND customer_identity.status='active'
    WHERE reservation.tenant_id=NEW.tenant_id AND reservation.store_id=NEW.store_id
      AND reservation.id=NEW.reservation_id AND reservation.customer_id IS NOT NULL
      AND reservation.preferred_schedule_id IS NOT NULL
      AND reservation.status IN ('pending','confirmed','arrived','seated')
      AND mbox.canonical_customer_id(
        reservation.tenant_id,reservation.store_id,reservation.customer_id
      )=NEW.canonical_customer_id
      AND mbox.canonical_customer_id(
        customer_identity.tenant_id,customer_identity.store_id,customer_identity.customer_id
      )=NEW.canonical_customer_id
  ) THEN
    RAISE EXCEPTION 'Reservation notification authorization is not owned by the customer family'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION mbox.validate_wechat_member_service_notification_authorization_owner()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM mbox.wechat_identities identity
    JOIN mbox.customer_identities customer_identity
      ON customer_identity.tenant_id=identity.tenant_id AND customer_identity.store_id=identity.store_id
     AND customer_identity.identity_kind='wechat'
     AND customer_identity.identity_hash=encode(sha256(convert_to('wechat:'||identity.principal_id,'UTF8')),'hex')
     AND customer_identity.status='active'
    WHERE identity.tenant_id=NEW.tenant_id AND identity.store_id=NEW.store_id
      AND identity.external_identity_id=NEW.identity_external_id
      AND identity.channel='mini_program' AND identity.revoked_at IS NULL
      AND customer_identity.customer_id=NEW.customer_id
      AND (identity.member_id IS NULL OR identity.member_id=NEW.membership_id)
  ) THEN
    RAISE EXCEPTION 'WeChat member-service authorization identity does not belong to customer';
  END IF;
  RETURN NEW;
END;
$$;

UPDATE mbox.normalized_schema_metadata SET schema_version='243',updated_at=clock_timestamp()
WHERE singleton=true AND schema_flavor='normalized-core-v1';
COMMIT;
