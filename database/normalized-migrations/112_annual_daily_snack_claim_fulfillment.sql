BEGIN;

-- A daily snack is not issued by a background scan: a qualified member must
-- first be at an open table and explicitly request it.  The short hold is
-- therefore separate from the booking-priority hold and is bounded by the
-- existing benefit-reservation invariant (at most 30 minutes).
ALTER TABLE mbox.loyalty_annual_benefit_rules
  ADD COLUMN redemption_hold_minutes smallint;

ALTER TABLE mbox.loyalty_annual_benefit_rules
  ADD CONSTRAINT loyalty_annual_benefit_daily_snack_hold_shape_ck CHECK (
    (rule_kind='daily_snack' AND redemption_hold_minutes BETWEEN 5 AND 30)
    OR (rule_kind<>'daily_snack' AND redemption_hold_minutes IS NULL)
  );

CREATE TABLE mbox.annual_daily_snack_claims (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  membership_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  policy_version_id uuid NOT NULL,
  rule_id uuid NOT NULL,
  business_date date NOT NULL,
  table_session_id uuid NOT NULL,
  claim_code text NOT NULL CHECK (claim_code ~ '^DSN-[A-Z0-9]{10,24}$'),
  quantity smallint NOT NULL CHECK (quantity BETWEEN 1 AND 100),
  benefit_id uuid,
  benefit_reservation_id uuid,
  status text NOT NULL DEFAULT 'initiated'
    CHECK (status IN ('initiated','reserved','redeemed','cancelled','expired')),
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id,store_id,membership_id)
    REFERENCES mbox.customer_memberships(tenant_id,store_id,id),
  FOREIGN KEY (tenant_id,store_id,customer_id)
    REFERENCES mbox.customers(tenant_id,store_id,id),
  FOREIGN KEY (tenant_id,store_id,policy_version_id)
    REFERENCES mbox.loyalty_annual_benefit_policy_versions(tenant_id,store_id,id),
  FOREIGN KEY (tenant_id,store_id,rule_id)
    REFERENCES mbox.loyalty_annual_benefit_rules(tenant_id,store_id,id),
  FOREIGN KEY (tenant_id,store_id,table_session_id)
    REFERENCES mbox.table_sessions(tenant_id,store_id,id),
  FOREIGN KEY (tenant_id,store_id,benefit_id)
    REFERENCES mbox.benefits(tenant_id,store_id,id),
  FOREIGN KEY (tenant_id,store_id,benefit_reservation_id)
    REFERENCES mbox.benefit_reservations(tenant_id,store_id,id),
  UNIQUE (tenant_id,store_id,membership_id,rule_id,business_date),
  UNIQUE (tenant_id,store_id,benefit_id),
  UNIQUE (tenant_id,store_id,benefit_reservation_id),
  UNIQUE (tenant_id,store_id,claim_code),
  UNIQUE (tenant_id,store_id,id),
  CHECK (
    (status='initiated' AND benefit_reservation_id IS NULL AND expires_at IS NULL)
    OR (status='reserved' AND benefit_id IS NOT NULL AND benefit_reservation_id IS NOT NULL AND expires_at IS NOT NULL)
    OR (status IN ('redeemed','cancelled','expired') AND benefit_id IS NOT NULL AND benefit_reservation_id IS NOT NULL AND expires_at IS NOT NULL)
  )
);

CREATE INDEX annual_daily_snack_claims_table_queue_idx
  ON mbox.annual_daily_snack_claims(tenant_id,store_id,table_session_id,business_date,status,created_at,id)
  WHERE status IN ('reserved','redeemed');
CREATE INDEX annual_daily_snack_claims_table_cap_idx
  ON mbox.annual_daily_snack_claims(tenant_id,store_id,table_session_id,rule_id,business_date,status);

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
    AND NEW.benefit_reservation_id IS NULL AND NEW.expires_at IS NULL THEN RETURN NEW;
  END IF;
  IF OLD.status='initiated' AND NEW.status='reserved'
    AND NEW.benefit_id IS NOT NULL AND NEW.benefit_reservation_id IS NOT NULL AND NEW.expires_at IS NOT NULL THEN
    RETURN NEW;
  END IF;
  IF OLD.status='reserved' AND NEW.status IN ('redeemed','cancelled','expired')
    AND NEW.benefit_id=OLD.benefit_id AND NEW.benefit_reservation_id=OLD.benefit_reservation_id
    AND NEW.expires_at=OLD.expires_at THEN RETURN NEW;
  END IF;
  RAISE EXCEPTION 'daily snack claim transition is invalid';
END $$;

CREATE OR REPLACE FUNCTION mbox.sync_annual_daily_snack_claim_from_reservation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IN ('cancelled','expired') AND OLD.status='reserved' THEN
    UPDATE mbox.annual_daily_snack_claims
    SET status=NEW.status,updated_at=clock_timestamp()
    WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id
      AND benefit_reservation_id=NEW.id AND status='reserved';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION mbox.complete_annual_benefit_grant_from_redemption()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE mbox.annual_daily_snack_claims
  SET status='redeemed',updated_at=clock_timestamp()
  WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id
    AND benefit_reservation_id=NEW.benefit_reservation_id AND status='reserved';
  UPDATE mbox.membership_annual_benefit_grants
  SET status='fulfilled',updated_at=clock_timestamp()
  WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id
    AND benefit_id=NEW.benefit_id AND status='active';
  RETURN NEW;
END $$;

CREATE TRIGGER annual_daily_snack_claims_protect
  BEFORE UPDATE OR DELETE ON mbox.annual_daily_snack_claims
  FOR EACH ROW EXECUTE FUNCTION mbox.protect_annual_daily_snack_claim();
CREATE TRIGGER annual_daily_snack_claims_touch
  BEFORE UPDATE ON mbox.annual_daily_snack_claims
  FOR EACH ROW EXECUTE FUNCTION mbox.touch_updated_at();
CREATE TRIGGER annual_daily_snack_claims_reservation_sync
  AFTER UPDATE OF status ON mbox.benefit_reservations
  FOR EACH ROW EXECUTE FUNCTION mbox.sync_annual_daily_snack_claim_from_reservation();
CREATE TRIGGER annual_daily_snack_claims_redemption_sync
  AFTER INSERT ON mbox.benefit_redemptions
  FOR EACH ROW EXECUTE FUNCTION mbox.complete_annual_benefit_grant_from_redemption();

ALTER TABLE mbox.annual_daily_snack_claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE mbox.annual_daily_snack_claims FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_store_isolation ON mbox.annual_daily_snack_claims
  USING (tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id())
  WITH CHECK (tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id());
GRANT SELECT,INSERT,UPDATE ON TABLE mbox.annual_daily_snack_claims TO mbox_runtime;
REVOKE DELETE ON TABLE mbox.annual_daily_snack_claims FROM mbox_runtime;

COMMENT ON TABLE mbox.annual_daily_snack_claims IS
  'One member, one published daily-snack rule and one business date. A claim is a short table-bound hold; staff redemption creates the actual zero-value order, inventory movement and KDS work.';

UPDATE mbox.normalized_schema_metadata
SET schema_version='112',updated_at=clock_timestamp()
WHERE singleton=true AND schema_flavor='normalized-core-v1';

COMMIT;
