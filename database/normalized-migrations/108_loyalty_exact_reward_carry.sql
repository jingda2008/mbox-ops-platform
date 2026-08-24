BEGIN;

-- A per-order rounded award permanently loses small eligible amounts.  The
-- exact-carry model preserves the original per-minor-unit ratio and stores a
-- separate signed remainder for each membership, frozen policy version,
-- currency and reward kind.  A later locked order can have a different tier
-- multiplier denominator; the repository promotes both fractions to their
-- least common denominator before changing this one carry fact.
ALTER TABLE mbox.loyalty_order_awards
  ADD COLUMN calculation_model text NOT NULL DEFAULT 'per_order_rounded'
    CHECK (calculation_model IN ('per_order_rounded','exact_carry'));

ALTER TABLE mbox.loyalty_order_awards
  DROP CONSTRAINT loyalty_order_awards_check1,
  DROP CONSTRAINT loyalty_order_awards_check2,
  ADD CONSTRAINT loyalty_order_awards_reversal_model_ck CHECK (
    calculation_model='exact_carry'
    OR (reversed_points<=awarded_points AND reversed_growth<=awarded_growth)
  );

CREATE TABLE mbox.loyalty_order_reward_contributions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  award_id uuid NOT NULL,
  membership_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  order_id uuid NOT NULL,
  payment_id uuid NOT NULL,
  policy_version_id uuid NOT NULL,
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  eligible_amount_minor bigint NOT NULL CHECK (eligible_amount_minor>=0),
  reversed_eligible_amount_minor bigint NOT NULL DEFAULT 0
    CHECK (reversed_eligible_amount_minor>=0 AND reversed_eligible_amount_minor<=eligible_amount_minor),
  points_numerator_per_minor bigint NOT NULL CHECK (points_numerator_per_minor>=0),
  points_denominator bigint NOT NULL CHECK (points_denominator>0),
  growth_numerator_per_minor bigint NOT NULL CHECK (growth_numerator_per_minor>=0),
  growth_denominator bigint NOT NULL CHECK (growth_denominator>0),
  rounding_mode text NOT NULL CHECK (rounding_mode IN ('floor','nearest')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id,store_id) REFERENCES mbox.stores(tenant_id,id),
  FOREIGN KEY (tenant_id,store_id,award_id,order_id,payment_id)
    REFERENCES mbox.loyalty_order_awards(tenant_id,store_id,id,order_id,payment_id),
  FOREIGN KEY (tenant_id,store_id,membership_id)
    REFERENCES mbox.customer_memberships(tenant_id,store_id,id),
  FOREIGN KEY (tenant_id,store_id,customer_id) REFERENCES mbox.customers(tenant_id,store_id,id),
  FOREIGN KEY (tenant_id,store_id,policy_version_id)
    REFERENCES mbox.loyalty_policy_versions(tenant_id,store_id,id),
  UNIQUE (tenant_id,store_id,award_id),
  UNIQUE (tenant_id,store_id,order_id),
  UNIQUE (tenant_id,store_id,payment_id),
  UNIQUE (tenant_id,store_id,id)
);

CREATE TRIGGER loyalty_order_reward_contributions_touch_updated_at
  BEFORE UPDATE ON mbox.loyalty_order_reward_contributions
  FOR EACH ROW EXECUTE FUNCTION mbox.touch_updated_at();

CREATE TABLE mbox.loyalty_reward_carry_balances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  membership_id uuid NOT NULL,
  policy_version_id uuid NOT NULL,
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  reward_kind text NOT NULL CHECK (reward_kind IN ('points','growth')),
  denominator bigint NOT NULL CHECK (denominator>0),
  rounding_mode text NOT NULL CHECK (rounding_mode IN ('floor','nearest')),
  remainder_numerator bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id,store_id) REFERENCES mbox.stores(tenant_id,id),
  FOREIGN KEY (tenant_id,store_id,membership_id)
    REFERENCES mbox.customer_memberships(tenant_id,store_id,id),
  FOREIGN KEY (tenant_id,store_id,policy_version_id)
    REFERENCES mbox.loyalty_policy_versions(tenant_id,store_id,id),
  UNIQUE (tenant_id,store_id,membership_id,policy_version_id,currency,reward_kind),
  UNIQUE (tenant_id,store_id,id)
);

CREATE TRIGGER loyalty_reward_carry_balances_touch_updated_at
  BEFORE UPDATE ON mbox.loyalty_reward_carry_balances
  FOR EACH ROW EXECUTE FUNCTION mbox.touch_updated_at();

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'loyalty_order_reward_contributions','loyalty_reward_carry_balances'
  ] LOOP
    EXECUTE format('ALTER TABLE mbox.%I ENABLE ROW LEVEL SECURITY',table_name);
    EXECUTE format('ALTER TABLE mbox.%I FORCE ROW LEVEL SECURITY',table_name);
    EXECUTE format(
      'CREATE POLICY tenant_store_isolation ON mbox.%I '
      'USING (tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id()) '
      'WITH CHECK (tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id())',
      table_name
    );
    EXECUTE format('REVOKE ALL ON TABLE mbox.%I FROM PUBLIC',table_name);
    EXECUTE format('GRANT SELECT,INSERT,UPDATE ON TABLE mbox.%I TO mbox_runtime',table_name);
  END LOOP;
END $$;

COMMENT ON TABLE mbox.loyalty_order_reward_contributions IS
  'Immutable original policy ratio per paid order plus the source amount reversed by typed refund facts.  Never reprice a refund with a current policy.';
COMMENT ON TABLE mbox.loyalty_reward_carry_balances IS
  'Signed exact fractions not yet represented by whole points or growth.  They are not spendable customer balances.';

UPDATE mbox.normalized_schema_metadata
SET schema_version='108',updated_at=clock_timestamp()
WHERE singleton=true AND schema_flavor='normalized-core-v1';

COMMIT;
