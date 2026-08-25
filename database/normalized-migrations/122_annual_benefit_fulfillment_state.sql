BEGIN;

-- Redemption confirms that an employee accepted the benefit.  It is not the
-- same fact as production/delivery.  Keep both moments so customer, staff and
-- audit projections cannot report a gift as completed while it is still on KDS.
ALTER TABLE mbox.annual_daily_snack_claims
  DROP CONSTRAINT annual_daily_snack_claims_status_check,
  DROP CONSTRAINT annual_daily_snack_claims_check;

ALTER TABLE mbox.annual_daily_snack_claims
  ADD COLUMN gift_order_id uuid,
  ADD COLUMN redeemed_by_employee_id uuid,
  ADD COLUMN redeemed_at timestamptz,
  ADD COLUMN fulfilled_at timestamptz,
  ADD CONSTRAINT annual_daily_snack_claims_status_check CHECK (
    status IN ('initiated','reserved','redeemed','fulfilled','cancelled','expired')
  ),
  ADD CONSTRAINT annual_daily_snack_claims_state_shape_ck CHECK (
    (status='initiated' AND benefit_reservation_id IS NULL AND expires_at IS NULL
      AND gift_order_id IS NULL AND redeemed_at IS NULL AND fulfilled_at IS NULL)
    OR (status='reserved' AND benefit_id IS NOT NULL AND benefit_reservation_id IS NOT NULL
      AND expires_at IS NOT NULL AND gift_order_id IS NULL AND redeemed_at IS NULL AND fulfilled_at IS NULL)
    OR (status='redeemed' AND benefit_id IS NOT NULL AND benefit_reservation_id IS NOT NULL
      AND expires_at IS NOT NULL AND gift_order_id IS NOT NULL AND redeemed_at IS NOT NULL
      AND fulfilled_at IS NULL)
    OR (status='fulfilled' AND benefit_id IS NOT NULL AND benefit_reservation_id IS NOT NULL
      AND expires_at IS NOT NULL AND gift_order_id IS NOT NULL AND redeemed_at IS NOT NULL
      AND fulfilled_at IS NOT NULL)
    OR (status IN ('cancelled','expired') AND benefit_id IS NOT NULL
      AND benefit_reservation_id IS NOT NULL AND expires_at IS NOT NULL
      AND gift_order_id IS NULL AND redeemed_at IS NULL AND fulfilled_at IS NULL)
  ),
  ADD CONSTRAINT annual_daily_snack_claims_gift_order_fk
    FOREIGN KEY (tenant_id,store_id,gift_order_id)
    REFERENCES mbox.orders(tenant_id,store_id,id),
  ADD CONSTRAINT annual_daily_snack_claims_redeemed_by_fk
    FOREIGN KEY (tenant_id,store_id,redeemed_by_employee_id)
    REFERENCES mbox.employees(tenant_id,store_id,id);

CREATE INDEX annual_daily_snack_claims_gift_order_idx
  ON mbox.annual_daily_snack_claims(tenant_id,store_id,gift_order_id)
  WHERE gift_order_id IS NOT NULL;

CREATE OR REPLACE FUNCTION mbox.protect_annual_daily_snack_claim()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' THEN RETURN NEW; END IF;
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'daily snack claims are append-only'; END IF;
  IF ROW(NEW.tenant_id,NEW.store_id,NEW.membership_id,NEW.customer_id,NEW.policy_version_id,
    NEW.rule_id,NEW.business_date,NEW.table_session_id,NEW.claim_code,NEW.quantity,NEW.created_at)
    IS DISTINCT FROM ROW(OLD.tenant_id,OLD.store_id,OLD.membership_id,OLD.customer_id,OLD.policy_version_id,
      OLD.rule_id,OLD.business_date,OLD.table_session_id,OLD.claim_code,OLD.quantity,OLD.created_at) THEN
    RAISE EXCEPTION 'daily snack claim facts are immutable';
  END IF;
  IF OLD.status='initiated' AND NEW.status='initiated'
    AND OLD.benefit_id IS NULL AND NEW.benefit_id IS NOT NULL
    AND NEW.benefit_reservation_id IS NULL AND NEW.expires_at IS NULL
    AND NEW.gift_order_id IS NULL AND NEW.redeemed_at IS NULL AND NEW.fulfilled_at IS NULL THEN RETURN NEW;
  END IF;
  IF OLD.status='initiated' AND NEW.status='reserved'
    AND NEW.benefit_id IS NOT NULL AND NEW.benefit_reservation_id IS NOT NULL AND NEW.expires_at IS NOT NULL
    AND NEW.gift_order_id IS NULL AND NEW.redeemed_at IS NULL AND NEW.fulfilled_at IS NULL THEN RETURN NEW;
  END IF;
  IF OLD.status='reserved' AND NEW.status IN ('cancelled','expired')
    AND NEW.benefit_id=OLD.benefit_id AND NEW.benefit_reservation_id=OLD.benefit_reservation_id
    AND NEW.expires_at=OLD.expires_at AND NEW.gift_order_id IS NULL
    AND NEW.redeemed_at IS NULL AND NEW.fulfilled_at IS NULL THEN RETURN NEW;
  END IF;
  IF OLD.status='reserved' AND NEW.status='redeemed'
    AND NEW.benefit_id=OLD.benefit_id AND NEW.benefit_reservation_id=OLD.benefit_reservation_id
    AND NEW.expires_at=OLD.expires_at AND NEW.gift_order_id IS NOT NULL
    AND NEW.redeemed_by_employee_id IS NOT NULL AND NEW.redeemed_at IS NOT NULL
    AND NEW.fulfilled_at IS NULL THEN RETURN NEW;
  END IF;
  IF OLD.status='redeemed' AND NEW.status='fulfilled'
    AND NEW.benefit_id=OLD.benefit_id AND NEW.benefit_reservation_id=OLD.benefit_reservation_id
    AND NEW.expires_at=OLD.expires_at AND NEW.gift_order_id=OLD.gift_order_id
    AND NEW.redeemed_by_employee_id=OLD.redeemed_by_employee_id AND NEW.redeemed_at=OLD.redeemed_at
    AND NEW.fulfilled_at IS NOT NULL THEN RETURN NEW;
  END IF;
  RAISE EXCEPTION 'daily snack claim transition is invalid';
END $$;

CREATE OR REPLACE FUNCTION mbox.complete_annual_benefit_grant_from_redemption()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE resolved_order_id uuid;
BEGIN
  IF NEW.gift_order_reference IS NOT NULL THEN
    SELECT orders.id INTO resolved_order_id
    FROM mbox.orders AS orders
    WHERE orders.tenant_id=NEW.tenant_id AND orders.store_id=NEW.store_id
      AND orders.public_id=NEW.gift_order_reference;
    IF resolved_order_id IS NULL THEN
      RAISE EXCEPTION 'gift benefit redemption has no authoritative order';
    END IF;
    UPDATE mbox.annual_daily_snack_claims
    SET status='redeemed',gift_order_id=resolved_order_id,
      redeemed_by_employee_id=NEW.redeemed_by_employee_id,redeemed_at=NEW.redeemed_at,
      updated_at=clock_timestamp()
    WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id
      AND benefit_reservation_id=NEW.benefit_reservation_id AND status='reserved';
  ELSE
    UPDATE mbox.membership_annual_benefit_grants
    SET status='fulfilled',updated_at=clock_timestamp()
    WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id
      AND benefit_id=NEW.benefit_id AND status='active';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION mbox.complete_annual_benefit_fulfillment_for_order(
  target_order_id uuid
) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE affected integer := 0;
BEGIN
  IF EXISTS (
    SELECT 1 FROM mbox.order_items AS item
    WHERE item.tenant_id=mbox.current_tenant_id() AND item.store_id=mbox.current_store_id()
      AND item.order_id=target_order_id AND item.fulfillment_station<>'none'
      AND item.status NOT IN ('delivered','cancelled')
  ) THEN RETURN 0; END IF;

  UPDATE mbox.annual_daily_snack_claims AS claim
  SET status='fulfilled',fulfilled_at=clock_timestamp(),updated_at=clock_timestamp()
  WHERE claim.tenant_id=mbox.current_tenant_id() AND claim.store_id=mbox.current_store_id()
    AND claim.gift_order_id=target_order_id AND claim.status='redeemed';
  GET DIAGNOSTICS affected = ROW_COUNT;

  UPDATE mbox.membership_annual_benefit_grants AS grant_row
  SET status='fulfilled',updated_at=clock_timestamp()
  FROM mbox.benefit_redemptions AS redemption
  JOIN mbox.orders AS orders
    ON orders.tenant_id=redemption.tenant_id AND orders.store_id=redemption.store_id
   AND orders.public_id=redemption.gift_order_reference
  WHERE orders.tenant_id=mbox.current_tenant_id() AND orders.store_id=mbox.current_store_id()
    AND orders.id=target_order_id
    AND grant_row.tenant_id=redemption.tenant_id AND grant_row.store_id=redemption.store_id
    AND grant_row.benefit_id=redemption.benefit_id AND grant_row.status='active';
  RETURN affected;
END $$;

COMMENT ON COLUMN mbox.annual_daily_snack_claims.redeemed_at IS
  'Employee confirmation time. The benefit may still be awaiting KDS production or delivery.';
COMMENT ON COLUMN mbox.annual_daily_snack_claims.fulfilled_at IS
  'Authoritative completion time after every physical order line has been delivered or cancelled.';

UPDATE mbox.normalized_schema_metadata
SET schema_version='122',updated_at=clock_timestamp()
WHERE singleton=true AND schema_flavor='normalized-core-v1';

COMMIT;
