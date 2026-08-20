BEGIN;

ALTER TABLE mbox.checkout_upgrade_offers
  ADD COLUMN bundle_fingerprint text NOT NULL DEFAULT repeat('0', 64)
    CHECK (bundle_fingerprint ~ '^[a-f0-9]{64}$'),
  ADD COLUMN recipe_fingerprint text NOT NULL DEFAULT repeat('0', 64)
    CHECK (recipe_fingerprint ~ '^[a-f0-9]{64}$');

ALTER TABLE mbox.checkout_upgrade_rules
  ADD COLUMN revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  ADD COLUMN drafted_by_employee_id uuid,
  ADD COLUMN approved_at timestamptz,
  ADD CONSTRAINT checkout_upgrade_rules_drafted_by_fk
    FOREIGN KEY (tenant_id, store_id, drafted_by_employee_id)
    REFERENCES mbox.employees(tenant_id, store_id, id);

UPDATE mbox.checkout_upgrade_rules
SET status=CASE WHEN status='active' THEN 'paused' ELSE status END,
  drafted_by_employee_id=approved_by_employee_id,
  approved_by_employee_id=NULL,
  approved_at=NULL,
  updated_at=clock_timestamp();

ALTER TABLE mbox.checkout_upgrade_rules
  ADD CONSTRAINT checkout_upgrade_rules_maker_checker_check CHECK (
    status<>'active'
    OR (
      drafted_by_employee_id IS NOT NULL
      AND approved_by_employee_id IS NOT NULL
      AND drafted_by_employee_id<>approved_by_employee_id
      AND approved_at IS NOT NULL
    )
  );

UPDATE mbox.checkout_upgrade_offers
SET status='expired', updated_at=clock_timestamp()
WHERE status IN ('offered','selected');

UPDATE mbox.customer_experience_features
SET rollout_state='disabled',
  reason='付款前升级待强类型出品产能暂留完成后重新验收开放',
  effective_from=clock_timestamp(), effective_until=NULL,
  updated_at=clock_timestamp()
WHERE feature_code='checkout_upgrade'
  AND rollout_state IN ('pilot','enabled');

UPDATE mbox.checkout_upgrade_offers
SET status='cancelled', converted_order_id=NULL, converted_at=NULL,
  updated_at=clock_timestamp()
WHERE status='converted' AND converted_order_id IS NULL;

UPDATE mbox.checkout_upgrade_offers
SET converted_order_id=NULL, converted_at=NULL, updated_at=clock_timestamp()
WHERE status<>'converted' AND (converted_order_id IS NOT NULL OR converted_at IS NOT NULL);

UPDATE mbox.checkout_upgrade_offers
SET converted_at=COALESCE(converted_at, updated_at)
WHERE status='converted' AND converted_order_id IS NOT NULL AND converted_at IS NULL;

ALTER TABLE mbox.checkout_upgrade_offers
  ADD CONSTRAINT checkout_upgrade_offers_converted_state_check CHECK (
    (status='converted' AND converted_order_id IS NOT NULL AND converted_at IS NOT NULL)
    OR (status<>'converted' AND converted_order_id IS NULL AND converted_at IS NULL)
  );

CREATE UNIQUE INDEX checkout_upgrade_offers_converted_order_uq
  ON mbox.checkout_upgrade_offers (tenant_id, store_id, converted_order_id)
  WHERE converted_order_id IS NOT NULL;

CREATE OR REPLACE FUNCTION mbox.seed_store_checkout_upgrade_permissions()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO mbox.staff_permission_definitions(
    tenant_id, store_id, code, name, category, description, status
  ) SELECT NEW.tenant_id, NEW.id, permission.code, permission.name,
    permission.category, permission.description, 'active'
  FROM (VALUES
    ('checkout.upgrade.rule.draft', '起草付款前升级规则', 'customer_experience', '编辑草稿、暂停或退役付款前升级规则，不可自行生效'),
    ('checkout.upgrade.rule.approve', '审批付款前升级规则', 'customer_experience', '由非起草人复核商品、价格、毛利和履约条件后批准生效')
  ) AS permission(code,name,category,description)
  ON CONFLICT (tenant_id,store_id,code) DO UPDATE SET
    name=EXCLUDED.name, category=EXCLUDED.category,
    description=EXCLUDED.description, status='active';
  RETURN NEW;
END $$;

CREATE TRIGGER stores_seed_checkout_upgrade_permissions
  AFTER INSERT ON mbox.stores
  FOR EACH ROW EXECUTE FUNCTION mbox.seed_store_checkout_upgrade_permissions();

INSERT INTO mbox.staff_permission_definitions(
  tenant_id, store_id, code, name, category, description, status
)
SELECT store.tenant_id, store.id, permission.code, permission.name,
  permission.category, permission.description, 'active'
FROM mbox.stores store
CROSS JOIN (VALUES
  ('checkout.upgrade.rule.draft', '起草付款前升级规则', 'customer_experience', '编辑草稿、暂停或退役付款前升级规则，不可自行生效'),
  ('checkout.upgrade.rule.approve', '审批付款前升级规则', 'customer_experience', '由非起草人复核商品、价格、毛利和履约条件后批准生效')
) AS permission(code,name,category,description)
ON CONFLICT (tenant_id,store_id,code) DO UPDATE SET
  name=EXCLUDED.name, category=EXCLUDED.category,
  description=EXCLUDED.description, status='active';

COMMENT ON COLUMN mbox.checkout_upgrade_offers.bundle_fingerprint IS
  'Server-generated fingerprint of the target bundle component identities, quantities, order and update versions at offer time.';
COMMENT ON COLUMN mbox.checkout_upgrade_offers.recipe_fingerprint IS
  'Server-generated fingerprint of active recipe versions and typed recipe items for the target and its components at offer time.';

COMMIT;
