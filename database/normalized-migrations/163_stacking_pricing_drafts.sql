BEGIN;

-- Draft versions only. No active rule, coupon grant, published price or order is
-- changed by this migration. A later transaction integration must explicitly
-- bind a validated version before any draft can become a charging authority.
CREATE TABLE mbox.stacking_pricing_drafts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  policy_code text NOT NULL CHECK (policy_code ~ '^[A-Z][A-Z0-9_]{1,39}$'),
  version integer NOT NULL CHECK (version > 0),
  allow_member_price boolean NOT NULL,
  allow_bundle_price boolean NOT NULL,
  allow_other_coupons boolean NOT NULL,
  allow_points boolean NOT NULL,
  max_coupons integer NOT NULL CHECK (max_coupons BETWEEN 1 AND 10),
  calculation_order text[] NOT NULL CHECK (
    cardinality(calculation_order)=3 AND calculation_order @> ARRAY['member','coupon','points']::text[]
  ),
  maximum_discount_minor bigint CHECK (maximum_discount_minor BETWEEN 0 AND 9007199254740991),
  minimum_payable_minor bigint NOT NULL CHECK (minimum_payable_minor BETWEEN 0 AND 9007199254740991),
  created_by_employee_id uuid NOT NULL,
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 2 AND 500),
  request_key text NOT NULL CHECK (length(request_key) BETWEEN 8 AND 128),
  request_fingerprint char(64) NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id,store_id) REFERENCES mbox.stores(tenant_id,id),
  FOREIGN KEY (tenant_id,store_id,created_by_employee_id) REFERENCES mbox.employees(tenant_id,store_id,id),
  UNIQUE (tenant_id,store_id,id),
  UNIQUE (tenant_id,store_id,policy_code,version),
  UNIQUE (tenant_id,store_id,request_key),
  CHECK (allow_other_coupons OR max_coupons=1)
);
CREATE INDEX stacking_pricing_drafts_recent_idx ON mbox.stacking_pricing_drafts(tenant_id,store_id,created_at DESC,id DESC);
ALTER TABLE mbox.stacking_pricing_drafts ENABLE ROW LEVEL SECURITY;
ALTER TABLE mbox.stacking_pricing_drafts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_store_isolation ON mbox.stacking_pricing_drafts
  USING (tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id())
  WITH CHECK (tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id());
REVOKE ALL ON mbox.stacking_pricing_drafts FROM PUBLIC,mbox_runtime;
GRANT SELECT,INSERT ON mbox.stacking_pricing_drafts TO mbox_runtime;

-- Complete wallet includes terminal/future benefits, unlike the old partial
-- active-only index. Bound per-customer keyset reads without indexing private JSON.
CREATE INDEX benefits_customer_wallet_idx ON mbox.benefits(tenant_id,store_id,customer_id,created_at DESC,id DESC);

UPDATE mbox.normalized_schema_metadata SET schema_version='163',updated_at=clock_timestamp()
WHERE singleton=true AND schema_flavor='normalized-core-v1';
COMMIT;
