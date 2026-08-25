BEGIN;

-- A failed post-redemption gift dispatch must have an audited terminal path.
-- Retrying forever leaves an active zero-value order, recipe inventory and the
-- table session permanently open.  Terminal resolution is intentionally
-- separate from benefit_redemptions, which remains append-only proof that an
-- employee accepted the customer's benefit.
ALTER TABLE mbox.complimentary_fulfillment_intents
  DROP CONSTRAINT complimentary_fulfillment_intents_status_check,
  DROP CONSTRAINT complimentary_fulfillment_intents_check,
  ADD COLUMN resolved_by_employee_id uuid,
  ADD COLUMN resolved_at timestamptz,
  ADD COLUMN resolution_code text,
  ADD COLUMN resolution_reason text,
  ADD COLUMN compensation_reference text,
  ADD CONSTRAINT complimentary_fulfillment_intents_resolved_by_fk
    FOREIGN KEY (tenant_id,store_id,resolved_by_employee_id)
    REFERENCES mbox.employees(tenant_id,store_id,id),
  ADD CONSTRAINT complimentary_fulfillment_intents_status_check CHECK (
    status IN ('pending','retry','dispatched','failed','cancelled','compensated')
  ),
  ADD CONSTRAINT complimentary_fulfillment_intents_state_shape_ck CHECK (
    (status IN ('pending','retry') AND dispatched_at IS NULL
      AND resolved_by_employee_id IS NULL AND resolved_at IS NULL
      AND resolution_code IS NULL AND resolution_reason IS NULL
      AND compensation_reference IS NULL)
    OR (status='dispatched' AND dispatched_at IS NOT NULL
      AND resolved_by_employee_id IS NULL AND resolved_at IS NULL
      AND resolution_code IS NULL AND resolution_reason IS NULL
      AND compensation_reference IS NULL)
    OR (status='failed' AND resolved_by_employee_id IS NULL AND resolved_at IS NULL
      AND resolution_code IS NULL AND resolution_reason IS NULL
      AND compensation_reference IS NULL)
    OR (status='cancelled' AND resolved_by_employee_id IS NOT NULL AND resolved_at IS NOT NULL
      AND resolution_code='cancel_release'
      AND length(btrim(COALESCE(resolution_reason,''))) BETWEEN 2 AND 500
      AND compensation_reference IS NULL)
    OR (status='compensated' AND resolved_by_employee_id IS NOT NULL AND resolved_at IS NOT NULL
      AND resolution_code='external_compensation'
      AND length(btrim(COALESCE(resolution_reason,''))) BETWEEN 2 AND 500
      AND length(btrim(COALESCE(compensation_reference,''))) BETWEEN 2 AND 200)
  );

CREATE TABLE mbox.complimentary_fulfillment_resolution_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  intent_id uuid NOT NULL,
  order_id uuid NOT NULL,
  benefit_id uuid NOT NULL,
  action text NOT NULL CHECK (action IN ('cancel_release','external_compensation')),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 2 AND 500),
  compensation_reference text,
  employee_id uuid NOT NULL,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 128),
  request_fingerprint text NOT NULL CHECK (length(request_fingerprint) BETWEEN 32 AND 128),
  released_inventory_reservation_count integer NOT NULL CHECK (released_inventory_reservation_count>=0),
  released_capacity_reservation_count integer NOT NULL CHECK (released_capacity_reservation_count>=0),
  cancelled_kds_task_count integer NOT NULL CHECK (cancelled_kds_task_count>=0),
  cancelled_order_item_count integer NOT NULL CHECK (cancelled_order_item_count>=0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id,store_id,intent_id)
    REFERENCES mbox.complimentary_fulfillment_intents(tenant_id,store_id,id),
  FOREIGN KEY (tenant_id,store_id,order_id) REFERENCES mbox.orders(tenant_id,store_id,id),
  FOREIGN KEY (tenant_id,store_id,benefit_id) REFERENCES mbox.benefits(tenant_id,store_id,id),
  FOREIGN KEY (tenant_id,store_id,employee_id) REFERENCES mbox.employees(tenant_id,store_id,id),
  UNIQUE (tenant_id,store_id,intent_id),
  UNIQUE (tenant_id,store_id,idempotency_key),
  UNIQUE (tenant_id,store_id,id),
  CHECK (
    (action='cancel_release' AND compensation_reference IS NULL)
    OR (action='external_compensation'
      AND length(btrim(COALESCE(compensation_reference,''))) BETWEEN 2 AND 200)
  )
);

CREATE TRIGGER complimentary_fulfillment_resolution_events_append_only
  BEFORE UPDATE OR DELETE ON mbox.complimentary_fulfillment_resolution_events
  FOR EACH ROW EXECUTE FUNCTION mbox.reject_row_change();

ALTER TABLE mbox.complimentary_fulfillment_resolution_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE mbox.complimentary_fulfillment_resolution_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_store_isolation ON mbox.complimentary_fulfillment_resolution_events
  USING (tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id())
  WITH CHECK (tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id());
GRANT SELECT,INSERT ON TABLE mbox.complimentary_fulfillment_resolution_events TO mbox_runtime;
REVOKE UPDATE,DELETE ON TABLE mbox.complimentary_fulfillment_resolution_events FROM mbox_runtime;

-- A daily snack accepted by an employee may later fail before any physical
-- production starts.  Preserve the original redemption facts while exposing
-- whether the system order was cancelled or an external compensation was
-- verified.  Neither state pretends that the original KDS order was delivered.
ALTER TABLE mbox.annual_daily_snack_claims
  DROP CONSTRAINT annual_daily_snack_claims_status_check,
  DROP CONSTRAINT annual_daily_snack_claims_state_shape_ck,
  ADD CONSTRAINT annual_daily_snack_claims_status_check CHECK (
    status IN (
      'initiated','reserved','redeemed','fulfilled','cancelled','expired',
      'cancelled_after_redemption','compensated'
    )
  ),
  ADD CONSTRAINT annual_daily_snack_claims_state_shape_ck CHECK (
    (status='initiated' AND benefit_reservation_id IS NULL AND expires_at IS NULL
      AND gift_order_id IS NULL AND redeemed_at IS NULL AND fulfilled_at IS NULL)
    OR (status='reserved' AND benefit_id IS NOT NULL AND benefit_reservation_id IS NOT NULL
      AND expires_at IS NOT NULL AND gift_order_id IS NULL AND redeemed_at IS NULL AND fulfilled_at IS NULL)
    OR (status IN ('redeemed','cancelled_after_redemption')
      AND benefit_id IS NOT NULL AND benefit_reservation_id IS NOT NULL
      AND expires_at IS NOT NULL AND gift_order_id IS NOT NULL AND redeemed_at IS NOT NULL
      AND fulfilled_at IS NULL)
    OR (status IN ('fulfilled','compensated')
      AND benefit_id IS NOT NULL AND benefit_reservation_id IS NOT NULL
      AND expires_at IS NOT NULL AND gift_order_id IS NOT NULL AND redeemed_at IS NOT NULL
      AND fulfilled_at IS NOT NULL)
    OR (status IN ('cancelled','expired') AND benefit_id IS NOT NULL
      AND benefit_reservation_id IS NOT NULL AND expires_at IS NOT NULL
      AND gift_order_id IS NULL AND redeemed_at IS NULL AND fulfilled_at IS NULL)
  );

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
  IF OLD.status='redeemed' AND NEW.status='cancelled_after_redemption'
    AND NEW.benefit_id=OLD.benefit_id AND NEW.benefit_reservation_id=OLD.benefit_reservation_id
    AND NEW.expires_at=OLD.expires_at AND NEW.gift_order_id=OLD.gift_order_id
    AND NEW.redeemed_by_employee_id=OLD.redeemed_by_employee_id AND NEW.redeemed_at=OLD.redeemed_at
    AND NEW.fulfilled_at IS NULL THEN RETURN NEW;
  END IF;
  IF OLD.status='redeemed' AND NEW.status='compensated'
    AND NEW.benefit_id=OLD.benefit_id AND NEW.benefit_reservation_id=OLD.benefit_reservation_id
    AND NEW.expires_at=OLD.expires_at AND NEW.gift_order_id=OLD.gift_order_id
    AND NEW.redeemed_by_employee_id=OLD.redeemed_by_employee_id AND NEW.redeemed_at=OLD.redeemed_at
    AND NEW.fulfilled_at IS NOT NULL THEN RETURN NEW;
  END IF;
  RAISE EXCEPTION 'daily snack claim transition is invalid';
END $$;

COMMENT ON TABLE mbox.complimentary_fulfillment_resolution_events IS
  'Append-only employee decision that safely terminates a failed complimentary order before production, including released holds and any verified external compensation.';
COMMENT ON COLUMN mbox.complimentary_fulfillment_intents.compensation_reference IS
  'Required receipt, incident or service reference when an authorized employee confirms an out-of-system compensation.';

UPDATE mbox.normalized_schema_metadata
SET schema_version='128',updated_at=clock_timestamp()
WHERE singleton=true AND schema_flavor='normalized-core-v1';

COMMIT;
