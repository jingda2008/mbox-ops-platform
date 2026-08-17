BEGIN;

ALTER TABLE mbox.products
  ADD COLUMN loyalty_eligible boolean NOT NULL DEFAULT true;

CREATE TABLE mbox.loyalty_policy_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  policy_code text NOT NULL CHECK (policy_code ~ '^[A-Z][A-Z0-9_]{2,63}$'),
  version integer NOT NULL CHECK (version > 0),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'paused', 'retired')),
  points_numerator integer NOT NULL CHECK (points_numerator >= 0),
  points_denominator_minor integer NOT NULL CHECK (points_denominator_minor > 0),
  growth_numerator integer NOT NULL CHECK (growth_numerator >= 0),
  growth_denominator_minor integer NOT NULL CHECK (growth_denominator_minor > 0),
  rounding_mode text NOT NULL DEFAULT 'floor' CHECK (rounding_mode IN ('floor', 'nearest')),
  points_validity_months integer NOT NULL CHECK (points_validity_months BETWEEN 1 AND 120),
  effective_from timestamptz,
  effective_until timestamptz,
  drafted_by_employee_id uuid NOT NULL,
  approved_by_employee_id uuid,
  approved_at timestamptz,
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 2 AND 500),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, drafted_by_employee_id)
    REFERENCES mbox.employees(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, approved_by_employee_id)
    REFERENCES mbox.employees(tenant_id, store_id, id),
  UNIQUE (tenant_id, store_id, policy_code, version),
  UNIQUE (tenant_id, store_id, id),
  CHECK (effective_until IS NULL OR effective_from IS NULL OR effective_until > effective_from),
  CHECK (
    (status = 'published' AND approved_by_employee_id IS NOT NULL
      AND approved_at IS NOT NULL AND approved_by_employee_id <> drafted_by_employee_id
      AND effective_from IS NOT NULL)
    OR (status <> 'published')
  )
);

CREATE UNIQUE INDEX loyalty_policy_versions_one_published_uq
  ON mbox.loyalty_policy_versions (tenant_id, store_id, policy_code)
  WHERE status = 'published';

CREATE TABLE mbox.loyalty_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  membership_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  available_points integer NOT NULL DEFAULT 0 CHECK (available_points >= 0),
  pending_recovery_points integer NOT NULL DEFAULT 0 CHECK (pending_recovery_points >= 0),
  growth_value integer NOT NULL DEFAULT 0 CHECK (growth_value >= 0),
  current_tier text NOT NULL DEFAULT 'member' CHECK (current_tier IN ('member', 'silver', 'gold')),
  redemption_status text NOT NULL DEFAULT 'active' CHECK (redemption_status IN ('active', 'suspended', 'closed')),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, membership_id)
    REFERENCES mbox.customer_memberships(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, customer_id)
    REFERENCES mbox.customers(tenant_id, store_id, id),
  UNIQUE (tenant_id, store_id, membership_id),
  UNIQUE (tenant_id, store_id, customer_id),
  UNIQUE (tenant_id, store_id, id)
);

INSERT INTO mbox.loyalty_accounts (
  tenant_id, store_id, membership_id, customer_id,
  available_points, growth_value, current_tier, redemption_status
)
SELECT membership.tenant_id, membership.store_id, membership.id, membership.customer_id,
  membership.points_balance, membership.lifetime_points,
  CASE membership.level WHEN 'silver' THEN 'silver' WHEN 'gold' THEN 'gold' ELSE 'member' END,
  CASE WHEN membership.status = 'active' THEN 'active' ELSE 'suspended' END
FROM mbox.customer_memberships membership
ON CONFLICT (tenant_id, store_id, membership_id) DO NOTHING;

ALTER TABLE mbox.orders
  ADD COLUMN loyalty_policy_version_id uuid,
  ADD CONSTRAINT orders_loyalty_policy_version_fk
    FOREIGN KEY (tenant_id, store_id, loyalty_policy_version_id)
    REFERENCES mbox.loyalty_policy_versions(tenant_id, store_id, id);

CREATE OR REPLACE FUNCTION mbox.lock_order_loyalty_policy_version()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.loyalty_policy_version_id IS NULL THEN
    SELECT policy.id INTO NEW.loyalty_policy_version_id
    FROM mbox.loyalty_policy_versions policy
    WHERE policy.tenant_id = NEW.tenant_id AND policy.store_id = NEW.store_id
      AND policy.policy_code = 'BASE' AND policy.status = 'published'
      AND policy.effective_from <= clock_timestamp()
      AND (policy.effective_until IS NULL OR policy.effective_until > clock_timestamp())
    ORDER BY policy.version DESC, policy.id DESC LIMIT 1;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER orders_lock_loyalty_policy_version
  BEFORE INSERT ON mbox.orders
  FOR EACH ROW EXECUTE FUNCTION mbox.lock_order_loyalty_policy_version();

ALTER TABLE mbox.loyalty_point_ledger
  DROP CONSTRAINT loyalty_point_ledger_entry_type_check,
  DROP CONSTRAINT loyalty_point_ledger_source_type_check,
  ADD COLUMN policy_version_id uuid,
  ADD COLUMN order_id uuid,
  ADD COLUMN payment_id uuid,
  ADD COLUMN refund_id uuid,
  ADD COLUMN reversal_of_entry_id uuid,
  ADD COLUMN available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  ADD CONSTRAINT loyalty_point_ledger_entry_type_check
    CHECK (entry_type IN ('earn', 'redeem', 'expire', 'reverse', 'supplement', 'adjust', 'restore')),
  ADD CONSTRAINT loyalty_point_ledger_source_type_check
    CHECK (source_type IN ('order', 'refund', 'redemption', 'activity', 'benefit', 'campaign', 'service_recovery', 'manual')),
  ADD CONSTRAINT loyalty_point_ledger_policy_fk
    FOREIGN KEY (tenant_id, store_id, policy_version_id)
    REFERENCES mbox.loyalty_policy_versions(tenant_id, store_id, id),
  ADD CONSTRAINT loyalty_point_ledger_order_fk
    FOREIGN KEY (tenant_id, store_id, order_id)
    REFERENCES mbox.orders(tenant_id, store_id, id),
  ADD CONSTRAINT loyalty_point_ledger_payment_fk
    FOREIGN KEY (tenant_id, store_id, payment_id)
    REFERENCES mbox.payments(tenant_id, store_id, id),
  ADD CONSTRAINT loyalty_point_ledger_refund_fk
    FOREIGN KEY (tenant_id, store_id, refund_id)
    REFERENCES mbox.refunds(tenant_id, store_id, id),
  ADD CONSTRAINT loyalty_point_ledger_reversal_fk
    FOREIGN KEY (tenant_id, store_id, reversal_of_entry_id)
    REFERENCES mbox.loyalty_point_ledger(tenant_id, store_id, id);

CREATE TABLE mbox.loyalty_growth_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  membership_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  entry_type text NOT NULL CHECK (entry_type IN ('earn', 'reverse', 'supplement', 'adjust')),
  growth_delta integer NOT NULL CHECK (growth_delta <> 0),
  balance_after integer NOT NULL CHECK (balance_after >= 0),
  policy_version_id uuid,
  order_id uuid,
  payment_id uuid,
  refund_id uuid,
  source_id text NOT NULL CHECK (length(btrim(source_id)) BETWEEN 1 AND 128),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 2 AND 256),
  created_by_employee_id uuid,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 128),
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, membership_id)
    REFERENCES mbox.customer_memberships(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, customer_id)
    REFERENCES mbox.customers(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, policy_version_id)
    REFERENCES mbox.loyalty_policy_versions(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, order_id) REFERENCES mbox.orders(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, payment_id) REFERENCES mbox.payments(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, refund_id) REFERENCES mbox.refunds(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, created_by_employee_id)
    REFERENCES mbox.employees(tenant_id, store_id, id),
  UNIQUE (tenant_id, store_id, idempotency_key),
  UNIQUE (tenant_id, store_id, id)
);

CREATE TABLE mbox.loyalty_order_awards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  membership_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  order_id uuid NOT NULL,
  payment_id uuid NOT NULL,
  policy_version_id uuid NOT NULL,
  eligible_amount_minor bigint NOT NULL CHECK (eligible_amount_minor >= 0),
  awarded_points integer NOT NULL CHECK (awarded_points >= 0),
  awarded_growth integer NOT NULL CHECK (awarded_growth >= 0),
  reversed_amount_minor bigint NOT NULL DEFAULT 0 CHECK (reversed_amount_minor >= 0),
  reversed_points integer NOT NULL DEFAULT 0 CHECK (reversed_points >= 0),
  reversed_growth integer NOT NULL DEFAULT 0 CHECK (reversed_growth >= 0),
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  awarded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, membership_id)
    REFERENCES mbox.customer_memberships(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, customer_id) REFERENCES mbox.customers(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, order_id) REFERENCES mbox.orders(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, payment_id) REFERENCES mbox.payments(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, policy_version_id)
    REFERENCES mbox.loyalty_policy_versions(tenant_id, store_id, id),
  UNIQUE (tenant_id, store_id, order_id),
  UNIQUE (tenant_id, store_id, payment_id),
  UNIQUE (tenant_id, store_id, id),
  CHECK (reversed_amount_minor <= eligible_amount_minor),
  CHECK (reversed_points <= awarded_points),
  CHECK (reversed_growth <= awarded_growth)
);

CREATE TABLE mbox.loyalty_supplement_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  public_id text NOT NULL CHECK (length(public_id) BETWEEN 8 AND 128),
  membership_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  order_id uuid NOT NULL,
  policy_version_id uuid NOT NULL,
  expected_points integer NOT NULL CHECK (expected_points >= 0),
  existing_points integer NOT NULL CHECK (existing_points >= 0),
  requested_points integer NOT NULL CHECK (requested_points >= 0),
  expected_growth integer NOT NULL CHECK (expected_growth >= 0),
  existing_growth integer NOT NULL CHECK (existing_growth >= 0),
  requested_growth integer NOT NULL CHECK (requested_growth >= 0),
  status text NOT NULL DEFAULT 'requested'
    CHECK (status IN ('requested', 'approved', 'rejected', 'executed', 'cancelled', 'not_required')),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 2 AND 500),
  requested_by_employee_id uuid NOT NULL,
  approved_by_employee_id uuid,
  decision_reason text,
  decided_at timestamptz,
  executed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, membership_id)
    REFERENCES mbox.customer_memberships(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, customer_id) REFERENCES mbox.customers(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, order_id) REFERENCES mbox.orders(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, policy_version_id)
    REFERENCES mbox.loyalty_policy_versions(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, requested_by_employee_id)
    REFERENCES mbox.employees(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, approved_by_employee_id)
    REFERENCES mbox.employees(tenant_id, store_id, id),
  UNIQUE (tenant_id, store_id, public_id),
  UNIQUE (tenant_id, store_id, id),
  CHECK (requested_points = GREATEST(expected_points - existing_points, 0)),
  CHECK (requested_growth = GREATEST(expected_growth - existing_growth, 0)),
  CHECK (requested_points > 0 OR requested_growth > 0),
  CHECK (approved_by_employee_id IS NULL OR approved_by_employee_id <> requested_by_employee_id),
  CHECK (
    (status = 'requested' AND approved_by_employee_id IS NULL AND decided_at IS NULL)
    OR (status IN ('approved', 'rejected', 'executed', 'not_required')
      AND approved_by_employee_id IS NOT NULL AND decided_at IS NOT NULL)
    OR status = 'cancelled'
  )
);

CREATE INDEX loyalty_point_ledger_expiry_idx
  ON mbox.loyalty_point_ledger (tenant_id, store_id, membership_id, expires_at, occurred_at, id)
  WHERE points_delta > 0 AND expires_at IS NOT NULL;
CREATE INDEX loyalty_growth_ledger_timeline_idx
  ON mbox.loyalty_growth_ledger (tenant_id, store_id, membership_id, occurred_at DESC, id);
CREATE INDEX loyalty_order_awards_reconciliation_idx
  ON mbox.loyalty_order_awards (tenant_id, store_id, awarded_at, order_id);
CREATE INDEX loyalty_supplement_requests_queue_idx
  ON mbox.loyalty_supplement_requests (tenant_id, store_id, status, created_at, id)
  WHERE status IN ('requested', 'approved');
CREATE UNIQUE INDEX loyalty_supplement_requests_active_order_uq
  ON mbox.loyalty_supplement_requests (tenant_id, store_id, order_id)
  WHERE status IN ('requested', 'approved');

CREATE OR REPLACE FUNCTION mbox.reject_published_loyalty_policy_change()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'published' THEN
      RAISE EXCEPTION 'published loyalty policy versions are immutable';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.status = 'published' THEN
    IF NEW.status NOT IN ('paused', 'retired')
      OR NEW.policy_code IS DISTINCT FROM OLD.policy_code
      OR NEW.version IS DISTINCT FROM OLD.version
      OR NEW.points_numerator IS DISTINCT FROM OLD.points_numerator
      OR NEW.points_denominator_minor IS DISTINCT FROM OLD.points_denominator_minor
      OR NEW.growth_numerator IS DISTINCT FROM OLD.growth_numerator
      OR NEW.growth_denominator_minor IS DISTINCT FROM OLD.growth_denominator_minor
      OR NEW.rounding_mode IS DISTINCT FROM OLD.rounding_mode
      OR NEW.points_validity_months IS DISTINCT FROM OLD.points_validity_months
      OR NEW.effective_from IS DISTINCT FROM OLD.effective_from
      OR NEW.drafted_by_employee_id IS DISTINCT FROM OLD.drafted_by_employee_id
      OR NEW.approved_by_employee_id IS DISTINCT FROM OLD.approved_by_employee_id
      OR NEW.approved_at IS DISTINCT FROM OLD.approved_at THEN
      RAISE EXCEPTION 'published loyalty policy versions are immutable';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER loyalty_policy_versions_immutable
  BEFORE UPDATE OR DELETE ON mbox.loyalty_policy_versions
  FOR EACH ROW EXECUTE FUNCTION mbox.reject_published_loyalty_policy_change();
CREATE TRIGGER loyalty_policy_versions_touch_updated_at
  BEFORE UPDATE ON mbox.loyalty_policy_versions
  FOR EACH ROW EXECUTE FUNCTION mbox.touch_updated_at();
CREATE TRIGGER loyalty_accounts_touch_updated_at
  BEFORE UPDATE ON mbox.loyalty_accounts
  FOR EACH ROW EXECUTE FUNCTION mbox.touch_updated_at();
CREATE TRIGGER loyalty_order_awards_touch_updated_at
  BEFORE UPDATE ON mbox.loyalty_order_awards
  FOR EACH ROW EXECUTE FUNCTION mbox.touch_updated_at();
CREATE TRIGGER loyalty_supplement_requests_touch_updated_at
  BEFORE UPDATE ON mbox.loyalty_supplement_requests
  FOR EACH ROW EXECUTE FUNCTION mbox.touch_updated_at();
CREATE TRIGGER loyalty_growth_ledger_append_only
  BEFORE UPDATE OR DELETE ON mbox.loyalty_growth_ledger
  FOR EACH ROW EXECUTE FUNCTION mbox.reject_row_change();

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'loyalty_policy_versions', 'loyalty_accounts', 'loyalty_growth_ledger',
    'loyalty_order_awards', 'loyalty_supplement_requests'
  ] LOOP
    EXECUTE format('ALTER TABLE mbox.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE mbox.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY tenant_store_isolation ON mbox.%I USING (tenant_id = mbox.current_tenant_id() AND store_id = mbox.current_store_id()) WITH CHECK (tenant_id = mbox.current_tenant_id() AND store_id = mbox.current_store_id())',
      table_name
    );
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE mbox.%I TO mbox_runtime', table_name);
  END LOOP;
END;
$$;

REVOKE UPDATE, DELETE ON TABLE mbox.loyalty_growth_ledger FROM mbox_runtime;
REVOKE DELETE ON TABLE mbox.loyalty_accounts, mbox.loyalty_order_awards,
  mbox.loyalty_policy_versions, mbox.loyalty_supplement_requests FROM mbox_runtime;

CREATE OR REPLACE FUNCTION mbox.seed_store_loyalty_permissions()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO mbox.staff_permission_definitions (
    tenant_id, store_id, code, name, category, description, status
  )
  SELECT NEW.tenant_id, NEW.id, permission.code, permission.name,
    'loyalty', permission.description, 'active'
  FROM (VALUES
    ('loyalty.policy.view', '查看会员规则', '查看积分、成长值、等级与兑换的已发布规则和历史版本'),
    ('loyalty.policy.manage', '编辑会员规则草稿', '创建和编辑会员经营规则草稿；不能自行批准发布'),
    ('loyalty.policy.approve', '复核发布会员规则', '由另一名授权人员复核并发布会员经营规则'),
    ('loyalty.account.view', '查看会员账户', '按数据范围查看可用积分、成长值和待回收积分'),
    ('loyalty.accrual.exception.view', '查看积分异常', '查看已付款未积分、积分不一致和待处理补发申请'),
    ('loyalty.accrual.request', '申请补发积分', '店长基于原订单和锁定规则申请系统计算的积分差额'),
    ('loyalty.accrual.approve', '复核补发积分', '由非申请人复核积分和成长值补发'),
    ('loyalty.accrual.reconcile', '执行积分对账', '运行或确认积分与付款退款事实对账'),
    ('loyalty.adjust.manual', '人工关怀积分', '用于非订单关怀补偿；与漏积分补发流程分离'),
    ('loyalty.redemption.fulfill', '履约积分兑换', '确认积分兑换商品或权益已实际交付')
  ) AS permission(code, name, description)
  ON CONFLICT (tenant_id, store_id, code) DO UPDATE
  SET name=EXCLUDED.name, category=EXCLUDED.category,
      description=EXCLUDED.description, status='active';
  RETURN NEW;
END;
$$;

CREATE TRIGGER stores_seed_loyalty_permissions
  AFTER INSERT ON mbox.stores
  FOR EACH ROW EXECUTE FUNCTION mbox.seed_store_loyalty_permissions();

INSERT INTO mbox.staff_permission_definitions (
  tenant_id, store_id, code, name, category, description, status
)
SELECT store.tenant_id, store.id, permission.code, permission.name,
  'loyalty', permission.description, 'active'
FROM mbox.stores store
CROSS JOIN (VALUES
  ('loyalty.policy.view', '查看会员规则', '查看积分、成长值、等级与兑换的已发布规则和历史版本'),
  ('loyalty.policy.manage', '编辑会员规则草稿', '创建和编辑会员经营规则草稿；不能自行批准发布'),
  ('loyalty.policy.approve', '复核发布会员规则', '由另一名授权人员复核并发布会员经营规则'),
  ('loyalty.account.view', '查看会员账户', '按数据范围查看可用积分、成长值和待回收积分'),
  ('loyalty.accrual.exception.view', '查看积分异常', '查看已付款未积分、积分不一致和待处理补发申请'),
  ('loyalty.accrual.request', '申请补发积分', '店长基于原订单和锁定规则申请系统计算的积分差额'),
  ('loyalty.accrual.approve', '复核补发积分', '由非申请人复核积分和成长值补发'),
  ('loyalty.accrual.reconcile', '执行积分对账', '运行或确认积分与付款退款事实对账'),
  ('loyalty.adjust.manual', '人工关怀积分', '用于非订单关怀补偿；与漏积分补发流程分离'),
  ('loyalty.redemption.fulfill', '履约积分兑换', '确认积分兑换商品或权益已实际交付')
) AS permission(code, name, description)
ON CONFLICT (tenant_id, store_id, code) DO UPDATE
SET name=EXCLUDED.name, category=EXCLUDED.category,
    description=EXCLUDED.description, status='active';

COMMENT ON TABLE mbox.loyalty_accounts IS
  'Authoritative separate balances for redeemable points, recovery debt and non-spendable growth value.';
COMMENT ON TABLE mbox.loyalty_order_awards IS
  'One authoritative loyalty award per fully paid order, bound to payment and immutable policy version.';
COMMENT ON COLUMN mbox.orders.loyalty_policy_version_id IS
  'Published loyalty policy version locked when the order is created; null means the order is outside loyalty accrual.';

COMMIT;
