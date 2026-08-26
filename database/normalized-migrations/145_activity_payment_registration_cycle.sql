BEGIN;

-- A registration can be reopened after an authoritatively closed, unpaid
-- activity payment. The payment must nevertheless retain the cycle it was
-- created for: a signed late success belongs to that earlier financial fact,
-- never to the newer registration attempt.
ALTER TABLE mbox.payments
  ADD COLUMN activity_registration_cycle integer;

UPDATE mbox.payments payment
SET activity_registration_cycle = registration.registration_cycle
FROM mbox.community_activity_registrations registration
WHERE payment.tenant_id = registration.tenant_id
  AND payment.store_id = registration.store_id
  AND payment.activity_registration_id = registration.id
  -- The registration row contains only its current attempt.  Earlier payments
  -- cannot be safely reconstructed from it and must remain unassigned.
  AND payment.id = registration.payment_id
  AND payment.payable_kind = 'activity_registration';

ALTER TABLE mbox.payments
  ADD CONSTRAINT payments_activity_registration_cycle_ck CHECK (
    (payable_kind = 'activity_registration'
      AND activity_registration_id IS NOT NULL
      AND (activity_registration_cycle IS NULL OR activity_registration_cycle >= 1))
    OR
    (payable_kind = 'order' AND activity_registration_cycle IS NULL)
  );

-- The old unique key treated a late success from cycle N as conflicting with
-- the one pending payment legitimately created for reopened cycle N+1.
-- Keep the one-active-payment invariant, but scope it to the immutable cycle.
DROP INDEX IF EXISTS mbox.payments_one_active_activity_payment_uq;
CREATE UNIQUE INDEX payments_one_active_activity_payment_cycle_uq
  ON mbox.payments(tenant_id, store_id, activity_registration_id, activity_registration_cycle)
  WHERE payable_kind='activity_registration'
    AND activity_registration_cycle IS NOT NULL
    AND status IN ('created','pending','succeeded','partially_refunded');

-- NULL is a migration-only historical state. All activity payments created
-- after this point must carry their immutable registration-cycle assignment.
CREATE FUNCTION mbox.require_activity_payment_registration_cycle()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.payable_kind='activity_registration'
    AND (NEW.activity_registration_id IS NULL OR NEW.activity_registration_cycle IS NULL) THEN
    RAISE EXCEPTION 'new activity payment requires an immutable registration cycle'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER payments_require_activity_registration_cycle
  BEFORE INSERT OR UPDATE OF payable_kind,activity_registration_id,activity_registration_cycle
  ON mbox.payments
  FOR EACH ROW EXECUTE FUNCTION mbox.require_activity_payment_registration_cycle();

-- 129 protects the original payment identity but predates this cycle field.
-- It is a financial attribution and must therefore never be retargeted after
-- creation, including for a delayed provider callback.
CREATE FUNCTION mbox.protect_activity_payment_registration_cycle()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.payable_kind='activity_registration'
    AND NEW.activity_registration_cycle IS DISTINCT FROM OLD.activity_registration_cycle THEN
    RAISE EXCEPTION 'activity payment registration cycle is immutable'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER payments_protect_activity_registration_cycle
  BEFORE UPDATE ON mbox.payments
  FOR EACH ROW EXECUTE FUNCTION mbox.protect_activity_payment_registration_cycle();

-- 091 derived the promotion cycle from the mutable registration row.  A late
-- callback for an earlier, reopened attempt would therefore credit the later
-- attempt. The payment's immutable cycle is authoritative; an unassigned
-- historical payment, or one no longer matching the current attempt, yields
-- no promotion fact.
CREATE OR REPLACE FUNCTION mbox.capture_loyalty_promotion_payment_trigger()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.payable_kind='activity_registration'
    AND NEW.activity_registration_cycle IS NOT NULL
    AND NEW.status='succeeded'
    AND (TG_OP='INSERT' OR OLD.status IS DISTINCT FROM 'succeeded') THEN
    INSERT INTO mbox.loyalty_promotion_trigger_facts(
      tenant_id,store_id,trigger_kind,registration_id,registration_cycle,
      activity_id,payment_id,occurred_at
    ) SELECT registration.tenant_id,registration.store_id,'activity_payment',
      registration.id,NEW.activity_registration_cycle,registration.activity_id,
      NEW.id,COALESCE(NEW.succeeded_at,NEW.updated_at,clock_timestamp())
    FROM mbox.community_activity_registrations registration
    WHERE registration.tenant_id=NEW.tenant_id AND registration.store_id=NEW.store_id
      AND registration.id=NEW.activity_registration_id
      AND registration.registration_cycle=NEW.activity_registration_cycle
    ON CONFLICT (tenant_id,store_id,trigger_kind,registration_id,registration_cycle)
      DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;

CREATE INDEX payments_activity_registration_cycle_idx
  ON mbox.payments(
    tenant_id, store_id, activity_registration_id,
    activity_registration_cycle, status, created_at, id
  )
  WHERE activity_registration_id IS NOT NULL;

COMMENT ON COLUMN mbox.payments.activity_registration_cycle IS
  'Immutable registration cycle that this activity payment financed. A delayed provider success is reconciled and refunded against this cycle, not a later reopened registration.';

UPDATE mbox.normalized_schema_metadata
SET schema_version='145', updated_at=clock_timestamp()
WHERE singleton=true AND schema_flavor='normalized-core-v1';

COMMIT;
