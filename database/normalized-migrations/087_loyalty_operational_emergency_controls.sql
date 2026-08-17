BEGIN;

CREATE TABLE mbox.loyalty_operational_control_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  capability text NOT NULL CHECK (capability IN (
    'points_accrual','points_redemption','wechat_notification'
  )),
  operation text NOT NULL CHECK (operation IN ('pause','resume')),
  resulting_state text NOT NULL CHECK (resulting_state IN ('active','paused')),
  control_version integer NOT NULL CHECK (control_version > 0),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 2 AND 500),
  review_at timestamptz,
  changed_by_employee_id uuid NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id,store_id) REFERENCES mbox.stores(tenant_id,id),
  FOREIGN KEY (tenant_id,store_id,changed_by_employee_id)
    REFERENCES mbox.employees(tenant_id,store_id,id),
  UNIQUE (tenant_id,store_id,capability,control_version),
  UNIQUE (tenant_id,store_id,id),
  UNIQUE (tenant_id,store_id,capability,control_version,id),
  CHECK (
    (operation='pause' AND resulting_state='paused')
    OR (operation='resume' AND resulting_state='active')
  ),
  CHECK (review_at IS NULL OR review_at>occurred_at)
);

CREATE TABLE mbox.loyalty_operational_control_states (
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  capability text NOT NULL CHECK (capability IN (
    'points_accrual','points_redemption','wechat_notification'
  )),
  state text NOT NULL CHECK (state IN ('active','paused')),
  control_version integer NOT NULL CHECK (control_version > 0),
  current_event_id uuid NOT NULL,
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 2 AND 500),
  review_at timestamptz,
  changed_by_employee_id uuid NOT NULL,
  changed_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id,store_id,capability),
  FOREIGN KEY (tenant_id,store_id) REFERENCES mbox.stores(tenant_id,id),
  FOREIGN KEY (tenant_id,store_id,changed_by_employee_id)
    REFERENCES mbox.employees(tenant_id,store_id,id),
  FOREIGN KEY (tenant_id,store_id,capability,control_version,current_event_id)
    REFERENCES mbox.loyalty_operational_control_events(
      tenant_id,store_id,capability,control_version,id
    ),
  CHECK (review_at IS NULL OR review_at>changed_at)
);

CREATE FUNCTION mbox.validate_loyalty_operational_control_state()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'loyalty operational control states cannot be deleted';
  END IF;
  IF TG_OP='INSERT' AND NEW.control_version<>1 THEN
    RAISE EXCEPTION 'first loyalty operational control version must be 1';
  END IF;
  IF TG_OP='UPDATE' AND (
    NEW.control_version<>OLD.control_version+1 OR NEW.state=OLD.state
    OR NEW.tenant_id<>OLD.tenant_id OR NEW.store_id<>OLD.store_id
    OR NEW.capability<>OLD.capability
  ) THEN
    RAISE EXCEPTION 'invalid loyalty operational control transition';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM mbox.loyalty_operational_control_events event
    WHERE event.tenant_id=NEW.tenant_id AND event.store_id=NEW.store_id
      AND event.capability=NEW.capability AND event.control_version=NEW.control_version
      AND event.id=NEW.current_event_id AND event.resulting_state=NEW.state
      AND event.reason=NEW.reason AND event.review_at IS NOT DISTINCT FROM NEW.review_at
      AND event.changed_by_employee_id=NEW.changed_by_employee_id
      AND event.occurred_at=NEW.changed_at
  ) THEN
    RAISE EXCEPTION 'loyalty operational control state requires its exact event';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER loyalty_operational_control_states_guard
  BEFORE INSERT OR UPDATE OR DELETE ON mbox.loyalty_operational_control_states
  FOR EACH ROW EXECUTE FUNCTION mbox.validate_loyalty_operational_control_state();
CREATE TRIGGER loyalty_operational_control_events_append_only
  BEFORE UPDATE OR DELETE ON mbox.loyalty_operational_control_events
  FOR EACH ROW EXECUTE FUNCTION mbox.reject_row_change();

ALTER TABLE mbox.payments
  ADD CONSTRAINT payments_loyalty_deferred_fk_uq
    UNIQUE (tenant_id,store_id,id,order_id);

CREATE TABLE mbox.loyalty_accrual_deferred_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  order_id uuid NOT NULL,
  payment_id uuid NOT NULL,
  policy_version_id uuid,
  pause_control_version integer NOT NULL CHECK (pause_control_version > 0),
  payment_succeeded_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending','processing','applied','not_applicable','review_required'
  )),
  worker_id text,
  claimed_at timestamptz,
  resolved_at timestamptz,
  resolution_code text CHECK (
    resolution_code IS NULL OR resolution_code IN (
      'award_applied','already_awarded','not_loyalty_eligible','processing_failed'
    )
  ),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id,store_id) REFERENCES mbox.stores(tenant_id,id),
  FOREIGN KEY (tenant_id,store_id,order_id) REFERENCES mbox.orders(tenant_id,store_id,id),
  FOREIGN KEY (tenant_id,store_id,payment_id,order_id)
    REFERENCES mbox.payments(tenant_id,store_id,id,order_id),
  FOREIGN KEY (tenant_id,store_id,policy_version_id)
    REFERENCES mbox.loyalty_policy_versions(tenant_id,store_id,id),
  UNIQUE (tenant_id,store_id,order_id),
  UNIQUE (tenant_id,store_id,payment_id),
  UNIQUE (tenant_id,store_id,id),
  CHECK (
    (status='pending' AND worker_id IS NULL AND claimed_at IS NULL
      AND resolved_at IS NULL AND resolution_code IS NULL)
    OR (status='processing' AND worker_id IS NOT NULL AND claimed_at IS NOT NULL
      AND resolved_at IS NULL AND resolution_code IS NULL)
    OR (status IN ('applied','not_applicable','review_required')
      AND worker_id IS NULL AND claimed_at IS NULL
      AND resolved_at IS NOT NULL AND resolution_code IS NOT NULL)
  )
);

CREATE INDEX loyalty_accrual_deferred_orders_pending_idx
  ON mbox.loyalty_accrual_deferred_orders(tenant_id,store_id,created_at,id)
  WHERE status IN ('pending','processing','review_required');

CREATE FUNCTION mbox.protect_loyalty_accrual_deferred_order()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'deferred loyalty accrual facts are immutable'; END IF;
  IF ROW(
    NEW.tenant_id,NEW.store_id,NEW.order_id,NEW.payment_id,NEW.policy_version_id,
    NEW.pause_control_version,NEW.payment_succeeded_at,NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.tenant_id,OLD.store_id,OLD.order_id,OLD.payment_id,OLD.policy_version_id,
    OLD.pause_control_version,OLD.payment_succeeded_at,OLD.created_at
  ) THEN RAISE EXCEPTION 'deferred loyalty accrual source facts are immutable'; END IF;
  IF NOT (
    (OLD.status='pending' AND NEW.status='processing')
    OR (OLD.status='review_required' AND NEW.status='processing')
    OR (OLD.status='processing' AND NEW.status='processing')
    OR (OLD.status='processing' AND NEW.status IN ('pending','applied','not_applicable','review_required'))
    OR (OLD.status=NEW.status AND OLD.status IN ('applied','not_applicable','review_required'))
  ) THEN RAISE EXCEPTION 'invalid deferred loyalty accrual transition % -> %',OLD.status,NEW.status; END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER loyalty_accrual_deferred_orders_guard
  BEFORE UPDATE OR DELETE ON mbox.loyalty_accrual_deferred_orders
  FOR EACH ROW EXECUTE FUNCTION mbox.protect_loyalty_accrual_deferred_order();

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'loyalty_operational_control_events','loyalty_operational_control_states',
    'loyalty_accrual_deferred_orders'
  ] LOOP
    EXECUTE format('ALTER TABLE mbox.%I ENABLE ROW LEVEL SECURITY',table_name);
    EXECUTE format('ALTER TABLE mbox.%I FORCE ROW LEVEL SECURITY',table_name);
    EXECUTE format(
      'CREATE POLICY tenant_store_isolation ON mbox.%I USING (tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id()) WITH CHECK (tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id())',
      table_name
    );
  END LOOP;
END $$;

GRANT SELECT,INSERT ON TABLE mbox.loyalty_operational_control_events TO mbox_runtime;
GRANT SELECT,INSERT,UPDATE ON TABLE mbox.loyalty_operational_control_states TO mbox_runtime;
GRANT SELECT,INSERT,UPDATE ON TABLE mbox.loyalty_accrual_deferred_orders TO mbox_runtime;
REVOKE DELETE ON TABLE mbox.loyalty_operational_control_states,
  mbox.loyalty_accrual_deferred_orders FROM mbox_runtime;

CREATE FUNCTION mbox.seed_store_loyalty_operational_control_permissions()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO mbox.staff_permission_definitions(
    tenant_id,store_id,code,name,category,description,status
  ) VALUES
    (NEW.tenant_id,NEW.id,'loyalty.operations.view','查看会员运行总闸','loyalty',
      '查看新积分、兑换和微信会员通知的紧急运行状态及复核时间','active'),
    (NEW.tenant_id,NEW.id,'loyalty.operations.control','控制会员运行总闸','loyalty',
      '最高管理人员暂停或恢复新积分、兑换和微信会员通知；不改变历史积分与权益','active')
  ON CONFLICT (tenant_id,store_id,code) DO UPDATE SET
    name=EXCLUDED.name,category=EXCLUDED.category,
    description=EXCLUDED.description,status='active';
  RETURN NEW;
END $$;

CREATE TRIGGER stores_seed_loyalty_operational_control_permissions
  AFTER INSERT ON mbox.stores FOR EACH ROW
  EXECUTE FUNCTION mbox.seed_store_loyalty_operational_control_permissions();

INSERT INTO mbox.staff_permission_definitions(
  tenant_id,store_id,code,name,category,description,status
)
SELECT store.tenant_id,store.id,permission.code,permission.name,
  'loyalty',permission.description,'active'
FROM mbox.stores store CROSS JOIN (VALUES
  ('loyalty.operations.view','查看会员运行总闸','查看新积分、兑换和微信会员通知的紧急运行状态及复核时间'),
  ('loyalty.operations.control','控制会员运行总闸','最高管理人员暂停或恢复新积分、兑换和微信会员通知；不改变历史积分与权益')
) permission(code,name,description)
ON CONFLICT (tenant_id,store_id,code) DO UPDATE SET
  name=EXCLUDED.name,category=EXCLUDED.category,
  description=EXCLUDED.description,status='active';

INSERT INTO mbox.role_permission_assignments(tenant_id,store_id,role_id,permission_id)
SELECT role.tenant_id,role.store_id,role.id,permission.id
FROM mbox.roles role
JOIN mbox.staff_permission_definitions permission
  ON permission.tenant_id=role.tenant_id AND permission.store_id=role.store_id
WHERE role.status='active' AND role.code='OWNER'
  AND permission.code IN ('loyalty.operations.view','loyalty.operations.control')
ON CONFLICT (tenant_id,store_id,role_id,permission_id) DO NOTHING;

CREATE FUNCTION mbox.seed_role_loyalty_operational_control_permissions()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.code='OWNER' AND NEW.status='active' THEN
    INSERT INTO mbox.role_permission_assignments(tenant_id,store_id,role_id,permission_id)
    SELECT NEW.tenant_id,NEW.store_id,NEW.id,permission.id
    FROM mbox.staff_permission_definitions permission
    WHERE permission.tenant_id=NEW.tenant_id AND permission.store_id=NEW.store_id
      AND permission.code IN ('loyalty.operations.view','loyalty.operations.control')
      AND permission.status='active'
    ON CONFLICT (tenant_id,store_id,role_id,permission_id) DO NOTHING;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER roles_seed_loyalty_operational_control_permissions
  AFTER INSERT ON mbox.roles FOR EACH ROW
  EXECUTE FUNCTION mbox.seed_role_loyalty_operational_control_permissions();

COMMENT ON TABLE mbox.loyalty_accrual_deferred_orders IS
  'Strong paid-order facts retained while new point accrual is paused; payment, fulfillment and refund remain independent.';
COMMENT ON TABLE mbox.loyalty_operational_control_events IS
  'Append-only owner emergency pause/resume facts; no JSON field decides runtime state.';

UPDATE mbox.normalized_schema_metadata
SET schema_version='087',updated_at=clock_timestamp()
WHERE singleton=true AND schema_flavor='normalized-core-v1';

COMMIT;
