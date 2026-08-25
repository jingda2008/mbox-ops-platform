BEGIN;

ALTER TABLE mbox.annual_daily_snack_claims
  ADD COLUMN attempt_no smallint NOT NULL DEFAULT 1 CHECK (attempt_no BETWEEN 1 AND 100);

CREATE TABLE mbox.annual_daily_snack_inventory_holds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  claim_id uuid NOT NULL,
  inventory_item_id uuid NOT NULL,
  quantity numeric(18,6) NOT NULL CHECK (quantity>0),
  status text NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved','converted','released')),
  reserved_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  completion_reason text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id,store_id,claim_id)
    REFERENCES mbox.annual_daily_snack_claims(tenant_id,store_id,id),
  FOREIGN KEY (tenant_id,store_id,inventory_item_id)
    REFERENCES mbox.inventory_items(tenant_id,store_id,id),
  UNIQUE (tenant_id,store_id,claim_id,inventory_item_id),
  UNIQUE (tenant_id,store_id,id),
  CHECK (
    (status='reserved' AND completed_at IS NULL AND completion_reason IS NULL)
    OR (status IN ('converted','released') AND completed_at IS NOT NULL
      AND length(btrim(completion_reason))>=2)
  )
);

CREATE INDEX annual_daily_snack_inventory_holds_active_idx
  ON mbox.annual_daily_snack_inventory_holds(tenant_id,store_id,inventory_item_id,claim_id)
  WHERE status='reserved';

CREATE TRIGGER annual_daily_snack_inventory_holds_touch
  BEFORE UPDATE ON mbox.annual_daily_snack_inventory_holds
  FOR EACH ROW EXECUTE FUNCTION mbox.touch_updated_at();

CREATE OR REPLACE FUNCTION mbox.release_annual_daily_snack_inventory_hold(
  target_claim_id uuid,
  release_reason text
) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE hold_row record; released integer := 0;
BEGIN
  IF length(btrim(release_reason))<2 THEN RAISE EXCEPTION 'inventory hold release reason is required'; END IF;
  FOR hold_row IN
    SELECT hold.id,hold.inventory_item_id,hold.quantity
    FROM mbox.annual_daily_snack_inventory_holds hold
    WHERE hold.tenant_id=mbox.current_tenant_id() AND hold.store_id=mbox.current_store_id()
      AND hold.claim_id=target_claim_id AND hold.status='reserved'
    ORDER BY hold.inventory_item_id FOR UPDATE
  LOOP
    UPDATE mbox.inventory_balances balance
    SET reserved_quantity=reserved_quantity-hold_row.quantity,updated_at=clock_timestamp()
    WHERE balance.tenant_id=mbox.current_tenant_id() AND balance.store_id=mbox.current_store_id()
      AND balance.inventory_item_id=hold_row.inventory_item_id
      AND balance.reserved_quantity>=hold_row.quantity;
    IF NOT FOUND THEN RAISE EXCEPTION 'daily snack inventory hold balance is inconsistent'; END IF;
    UPDATE mbox.annual_daily_snack_inventory_holds
    SET status='released',completed_at=clock_timestamp(),completion_reason=btrim(release_reason)
    WHERE tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id()
      AND id=hold_row.id AND status='reserved';
    released := released+1;
  END LOOP;
  RETURN released;
END $$;

CREATE OR REPLACE FUNCTION mbox.convert_annual_daily_snack_inventory_hold(
  target_benefit_id uuid
) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE hold_row record; converted integer := 0;
BEGIN
  FOR hold_row IN
    SELECT hold.id,hold.inventory_item_id,hold.quantity
    FROM mbox.annual_daily_snack_claims claim
    JOIN mbox.annual_daily_snack_inventory_holds hold
      ON hold.tenant_id=claim.tenant_id AND hold.store_id=claim.store_id AND hold.claim_id=claim.id
    WHERE claim.tenant_id=mbox.current_tenant_id() AND claim.store_id=mbox.current_store_id()
      AND claim.benefit_id=target_benefit_id AND claim.status='reserved' AND hold.status='reserved'
    ORDER BY hold.inventory_item_id FOR UPDATE OF claim,hold
  LOOP
    UPDATE mbox.inventory_balances balance
    SET reserved_quantity=reserved_quantity-hold_row.quantity,updated_at=clock_timestamp()
    WHERE balance.tenant_id=mbox.current_tenant_id() AND balance.store_id=mbox.current_store_id()
      AND balance.inventory_item_id=hold_row.inventory_item_id
      AND balance.reserved_quantity>=hold_row.quantity;
    IF NOT FOUND THEN RAISE EXCEPTION 'daily snack inventory conversion balance is inconsistent'; END IF;
    UPDATE mbox.annual_daily_snack_inventory_holds
    SET status='converted',completed_at=clock_timestamp(),completion_reason='转换为零元订单库存预留'
    WHERE tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id()
      AND id=hold_row.id AND status='reserved';
    converted := converted+1;
  END LOOP;
  RETURN converted;
END $$;

CREATE OR REPLACE FUNCTION mbox.release_daily_snack_hold_from_reservation()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE claim_id uuid;
BEGIN
  IF OLD.status='reserved' AND NEW.status IN ('cancelled','expired') THEN
    SELECT claim.id INTO claim_id
    FROM mbox.annual_daily_snack_claims claim
    WHERE claim.tenant_id=NEW.tenant_id AND claim.store_id=NEW.store_id
      AND claim.benefit_reservation_id=NEW.id;
    IF claim_id IS NOT NULL THEN
      PERFORM mbox.release_annual_daily_snack_inventory_hold(
        claim_id,CASE NEW.status WHEN 'expired' THEN '每日点心暂留超时释放' ELSE '每日点心取消释放' END
      );
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER benefit_reservations_daily_snack_inventory_release
  AFTER UPDATE OF status ON mbox.benefit_reservations
  FOR EACH ROW EXECUTE FUNCTION mbox.release_daily_snack_hold_from_reservation();

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
  IF OLD.status IN ('cancelled','expired') AND NEW.status='initiated'
    AND NEW.attempt_no=OLD.attempt_no+1 AND NEW.benefit_id=OLD.benefit_id
    AND NEW.benefit_reservation_id IS NULL AND NEW.expires_at IS NULL
    AND NEW.gift_order_id IS NULL AND NEW.redeemed_by_employee_id IS NULL
    AND NEW.redeemed_at IS NULL AND NEW.fulfilled_at IS NULL THEN RETURN NEW;
  END IF;
  IF NEW.attempt_no<>OLD.attempt_no THEN RAISE EXCEPTION 'daily snack attempt transition is invalid'; END IF;
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

ALTER TABLE mbox.annual_daily_snack_inventory_holds ENABLE ROW LEVEL SECURITY;
ALTER TABLE mbox.annual_daily_snack_inventory_holds FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_store_isolation ON mbox.annual_daily_snack_inventory_holds
  USING (tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id())
  WITH CHECK (tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id());
GRANT SELECT,INSERT,UPDATE ON TABLE mbox.annual_daily_snack_inventory_holds TO mbox_runtime;
REVOKE DELETE ON TABLE mbox.annual_daily_snack_inventory_holds FROM mbox_runtime;

UPDATE mbox.normalized_schema_metadata
SET schema_version='123',updated_at=clock_timestamp()
WHERE singleton=true AND schema_flavor='normalized-core-v1';

COMMIT;
