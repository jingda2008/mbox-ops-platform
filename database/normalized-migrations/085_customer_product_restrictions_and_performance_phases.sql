BEGIN;

-- A restriction can only originate from one option that the same customer
-- actually received. These composite keys prevent a runtime caller from
-- pairing an unrelated session, option, customer or product.
ALTER TABLE mbox.recommendation_sessions
  ADD CONSTRAINT recommendation_sessions_restriction_source_uq
    UNIQUE (tenant_id, store_id, id, customer_id);

ALTER TABLE mbox.recommendation_options
  ADD CONSTRAINT recommendation_options_restriction_source_uq
    UNIQUE (tenant_id, store_id, recommendation_session_id, id, product_id);

CREATE TABLE mbox.customer_product_restrictions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  public_id text NOT NULL CHECK (length(public_id) BETWEEN 8 AND 128),
  customer_id uuid NOT NULL,
  source_customer_id uuid NOT NULL,
  product_id uuid NOT NULL,
  restriction_type text NOT NULL
    CHECK (restriction_type IN ('dislike','allergy_or_cannot_consume')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','withdrawn')),
  source_recommendation_session_id uuid NOT NULL,
  source_recommendation_option_id uuid NOT NULL,
  created_by_customer_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  withdrawn_by_customer_id uuid,
  withdrawn_at timestamptz,
  withdrawal_reason text,
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, customer_id)
    REFERENCES mbox.customers(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, source_customer_id)
    REFERENCES mbox.customers(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, product_id)
    REFERENCES mbox.products(tenant_id, store_id, id),
  FOREIGN KEY (
    tenant_id, store_id, source_recommendation_session_id, source_customer_id
  ) REFERENCES mbox.recommendation_sessions(tenant_id, store_id, id, customer_id),
  FOREIGN KEY (
    tenant_id, store_id, source_recommendation_session_id,
    source_recommendation_option_id, product_id
  ) REFERENCES mbox.recommendation_options(
    tenant_id, store_id, recommendation_session_id, id, product_id
  ),
  FOREIGN KEY (tenant_id, store_id, created_by_customer_id)
    REFERENCES mbox.customers(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, withdrawn_by_customer_id)
    REFERENCES mbox.customers(tenant_id, store_id, id),
  UNIQUE (tenant_id, store_id, public_id),
  UNIQUE (tenant_id, store_id, id),
  CHECK (created_by_customer_id=source_customer_id),
  CHECK (
    (status='active' AND withdrawn_by_customer_id IS NULL
      AND withdrawn_at IS NULL AND withdrawal_reason IS NULL)
    OR
    (status='withdrawn' AND withdrawn_by_customer_id IS NOT NULL
      AND withdrawn_at IS NOT NULL
      AND length(btrim(withdrawal_reason)) BETWEEN 2 AND 240)
  )
);

CREATE FUNCTION mbox.assert_customer_product_restriction_family()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE resolved_canonical_customer_id uuid;
BEGIN
  WITH RECURSIVE ancestry AS (
    SELECT customer.id,customer.merged_into_customer_id,0 AS depth
    FROM mbox.customers customer
    WHERE customer.tenant_id=NEW.tenant_id AND customer.store_id=NEW.store_id
      AND customer.id=NEW.source_customer_id
    UNION ALL
    SELECT parent.id,parent.merged_into_customer_id,child.depth+1
    FROM mbox.customers parent JOIN ancestry child
      ON child.merged_into_customer_id=parent.id
    WHERE parent.tenant_id=NEW.tenant_id AND parent.store_id=NEW.store_id
      AND child.depth<32
  )
  SELECT id INTO resolved_canonical_customer_id
  FROM ancestry WHERE merged_into_customer_id IS NULL
  ORDER BY depth DESC LIMIT 1;
  IF resolved_canonical_customer_id IS NULL
      OR resolved_canonical_customer_id IS DISTINCT FROM NEW.customer_id THEN
    RAISE EXCEPTION 'customer product restriction family mismatch' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER customer_product_restrictions_assert_family
  BEFORE INSERT OR UPDATE OF customer_id,source_customer_id
  ON mbox.customer_product_restrictions
  FOR EACH ROW EXECUTE FUNCTION mbox.assert_customer_product_restriction_family();

CREATE UNIQUE INDEX customer_product_restrictions_active_uq
  ON mbox.customer_product_restrictions (
    tenant_id, store_id, customer_id, product_id
  ) WHERE status='active';

CREATE INDEX customer_product_restrictions_customer_idx
  ON mbox.customer_product_restrictions (
    tenant_id, store_id, customer_id, status, created_at DESC, id
  );

CREATE TABLE mbox.product_performance_phase_eligibilities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  product_id uuid NOT NULL,
  phase_code text NOT NULL CHECK (phase_code IN (
    'before_show','acoustic','band_live','intermission','after_show'
  )),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','retired')),
  configured_by_employee_id uuid NOT NULL,
  configuration_reason text NOT NULL CHECK (length(btrim(configuration_reason)) BETWEEN 2 AND 240),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  retired_by_employee_id uuid,
  retired_at timestamptz,
  retirement_reason text,
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, product_id)
    REFERENCES mbox.products(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, configured_by_employee_id)
    REFERENCES mbox.employees(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, retired_by_employee_id)
    REFERENCES mbox.employees(tenant_id, store_id, id),
  UNIQUE (tenant_id, store_id, id),
  CHECK (
    (status='active' AND retired_by_employee_id IS NULL
      AND retired_at IS NULL AND retirement_reason IS NULL)
    OR
    (status='retired' AND retired_by_employee_id IS NOT NULL
      AND retired_at IS NOT NULL
      AND length(btrim(retirement_reason)) BETWEEN 2 AND 240)
  )
);

CREATE UNIQUE INDEX product_performance_phase_eligibilities_active_uq
  ON mbox.product_performance_phase_eligibilities (
    tenant_id, store_id, product_id, phase_code
  ) WHERE status='active';

CREATE INDEX product_performance_phase_eligibilities_product_idx
  ON mbox.product_performance_phase_eligibilities (
    tenant_id, store_id, product_id, status, phase_code, id
  );

CREATE TABLE mbox.schedule_performance_phase_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  public_id text NOT NULL CHECK (length(public_id) BETWEEN 8 AND 128),
  schedule_id uuid NOT NULL,
  phase_code text NOT NULL CHECK (phase_code IN (
    'before_show','acoustic','band_live','intermission','after_show'
  )),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','ended','cancelled')),
  started_by_employee_id uuid NOT NULL,
  start_reason text NOT NULL CHECK (length(btrim(start_reason)) BETWEEN 2 AND 240),
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  ended_by_employee_id uuid,
  ended_at timestamptz,
  end_reason text,
  cancelled_by_employee_id uuid,
  cancelled_at timestamptz,
  cancellation_reason text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, schedule_id)
    REFERENCES mbox.schedules(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, started_by_employee_id)
    REFERENCES mbox.employees(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, ended_by_employee_id)
    REFERENCES mbox.employees(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, cancelled_by_employee_id)
    REFERENCES mbox.employees(tenant_id, store_id, id),
  UNIQUE (tenant_id, store_id, public_id),
  UNIQUE (tenant_id, store_id, id),
  CHECK (
    (status='active' AND ended_by_employee_id IS NULL AND ended_at IS NULL
      AND end_reason IS NULL AND cancelled_by_employee_id IS NULL
      AND cancelled_at IS NULL AND cancellation_reason IS NULL)
    OR
    (status='ended' AND ended_by_employee_id IS NOT NULL AND ended_at IS NOT NULL
      AND length(btrim(end_reason)) BETWEEN 2 AND 240
      AND cancelled_by_employee_id IS NULL AND cancelled_at IS NULL
      AND cancellation_reason IS NULL)
    OR
    (status='cancelled' AND cancelled_by_employee_id IS NOT NULL
      AND cancelled_at IS NOT NULL
      AND length(btrim(cancellation_reason)) BETWEEN 2 AND 240
      AND ended_by_employee_id IS NULL AND ended_at IS NULL AND end_reason IS NULL)
  ),
  CHECK (ended_at IS NULL OR ended_at>=started_at),
  CHECK (cancelled_at IS NULL OR cancelled_at>=started_at)
);

-- M-BOX has one customer-facing live stage. A store-wide unique active event
-- makes the phase authoritative; concurrent starts fail instead of producing
-- an ambiguous recommendation signal.
CREATE UNIQUE INDEX schedule_performance_phase_events_store_active_uq
  ON mbox.schedule_performance_phase_events (tenant_id, store_id)
  WHERE status='active';

CREATE INDEX schedule_performance_phase_events_schedule_idx
  ON mbox.schedule_performance_phase_events (
    tenant_id, store_id, schedule_id, started_at DESC, id
  );

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'customer_product_restrictions',
    'product_performance_phase_eligibilities',
    'schedule_performance_phase_events'
  ] LOOP
    EXECUTE format('ALTER TABLE mbox.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE mbox.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY tenant_store_isolation ON mbox.%I USING (tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id()) WITH CHECK (tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id())',
      table_name
    );
    EXECUTE format('GRANT SELECT,INSERT,UPDATE ON TABLE mbox.%I TO mbox_runtime', table_name);
  END LOOP;
END $$;

CREATE FUNCTION mbox.seed_store_performance_phase_permissions()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO mbox.staff_permission_definitions(
    tenant_id,store_id,code,name,category,description,status
  ) VALUES
    (NEW.tenant_id,NEW.id,'performance.phase.manage','管理现场演出阶段','performance',
      '启动、结束或取消当前现场演出阶段；活动阶段直接影响受限商品推荐','active'),
    (NEW.tenant_id,NEW.id,'recommendation.phase.configure','配置商品演出阶段','customer_experience',
      '配置商品允许参与推荐的现场演出阶段；空配置代表不受阶段限制','active')
  ON CONFLICT (tenant_id,store_id,code) DO UPDATE SET
    name=EXCLUDED.name,category=EXCLUDED.category,
    description=EXCLUDED.description,status='active';
  RETURN NEW;
END $$;

CREATE TRIGGER stores_seed_performance_phase_permissions
  AFTER INSERT ON mbox.stores
  FOR EACH ROW EXECUTE FUNCTION mbox.seed_store_performance_phase_permissions();

INSERT INTO mbox.staff_permission_definitions(
  tenant_id,store_id,code,name,category,description,status
)
SELECT store.tenant_id,store.id,permission.code,permission.name,
  permission.category,permission.description,'active'
FROM mbox.stores store CROSS JOIN (VALUES
  ('performance.phase.manage','管理现场演出阶段','performance',
    '启动、结束或取消当前现场演出阶段；活动阶段直接影响受限商品推荐'),
  ('recommendation.phase.configure','配置商品演出阶段','customer_experience',
    '配置商品允许参与推荐的现场演出阶段；空配置代表不受阶段限制')
) permission(code,name,category,description)
ON CONFLICT (tenant_id,store_id,code) DO UPDATE SET
  name=EXCLUDED.name,category=EXCLUDED.category,
  description=EXCLUDED.description,status='active';

INSERT INTO mbox.role_permission_assignments(tenant_id,store_id,role_id,permission_id)
SELECT role.tenant_id,role.store_id,role.id,permission.id
FROM mbox.roles role
JOIN mbox.staff_permission_definitions permission
  ON permission.tenant_id=role.tenant_id AND permission.store_id=role.store_id
WHERE role.status='active' AND (
  (role.code IN ('OWNER','OPS_LEAD','MANAGER','STAGE_OPS')
    AND permission.code='performance.phase.manage')
  OR
  (role.code IN ('OWNER','OPS_LEAD','MANAGER')
    AND permission.code='recommendation.phase.configure')
)
ON CONFLICT (tenant_id,store_id,role_id,permission_id) DO NOTHING;

CREATE FUNCTION mbox.seed_role_performance_phase_permissions()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO mbox.role_permission_assignments(tenant_id,store_id,role_id,permission_id)
  SELECT NEW.tenant_id,NEW.store_id,NEW.id,permission.id
  FROM mbox.staff_permission_definitions permission
  WHERE permission.tenant_id=NEW.tenant_id AND permission.store_id=NEW.store_id
    AND (
      (NEW.code IN ('OWNER','OPS_LEAD','MANAGER','STAGE_OPS')
        AND permission.code='performance.phase.manage')
      OR
      (NEW.code IN ('OWNER','OPS_LEAD','MANAGER')
        AND permission.code='recommendation.phase.configure')
    )
  ON CONFLICT (tenant_id,store_id,role_id,permission_id) DO NOTHING;
  RETURN NEW;
END $$;

CREATE TRIGGER roles_seed_performance_phase_permissions
  AFTER INSERT ON mbox.roles
  FOR EACH ROW EXECUTE FUNCTION mbox.seed_role_performance_phase_permissions();

COMMENT ON TABLE mbox.customer_product_restrictions IS
  'Customer-owned strong product exclusions created only by explicit dislike or allergy/cannot-consume choices; recommendation JSON is never authoritative.';
COMMENT ON TABLE mbox.product_performance_phase_eligibilities IS
  'Strong active/retired product-to-performance-phase recommendation eligibility; no active rows means the product is unrestricted.';
COMMENT ON TABLE mbox.schedule_performance_phase_events IS
  'Authoritative employee-operated live phase events. Restricted products fail closed when no single active event exists.';

UPDATE mbox.normalized_schema_metadata
SET schema_version='085',updated_at=clock_timestamp()
WHERE singleton=true AND schema_flavor='normalized-core-v1';

COMMIT;
