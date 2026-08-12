BEGIN;

CREATE TABLE mbox.staff_access_configuration_definitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  definition_kind text NOT NULL CHECK (definition_kind IN ('approval_limit', 'data_scope', 'navigation')),
  code text NOT NULL CHECK (code ~ '^[a-z][a-z0-9_.-]{2,127}$'),
  label text NOT NULL CHECK (length(btrim(label)) > 0),
  description text,
  required_permission_codes text[] NOT NULL DEFAULT ARRAY[]::text[],
  sort_order integer NOT NULL DEFAULT 0,
  config jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(config) = 'object'),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  UNIQUE (tenant_id, store_id, definition_kind, code),
  UNIQUE (tenant_id, store_id, id)
);

ALTER TABLE mbox.staff_access_configuration_definitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE mbox.staff_access_configuration_definitions FORCE ROW LEVEL SECURITY;
CREATE POLICY staff_access_configuration_definitions_tenant_store_policy
  ON mbox.staff_access_configuration_definitions
  USING (tenant_id = mbox.current_tenant_id() AND store_id = mbox.current_store_id())
  WITH CHECK (tenant_id = mbox.current_tenant_id() AND store_id = mbox.current_store_id());

GRANT SELECT ON TABLE mbox.staff_access_configuration_definitions TO mbox_runtime;

CREATE OR REPLACE FUNCTION mbox.seed_staff_access_configuration_definitions(
  target_tenant_id uuid,
  target_store_id uuid
) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO mbox.staff_access_configuration_definitions (
    tenant_id, store_id, definition_kind, code, label, description,
    required_permission_codes, sort_order, config, status
  )
  SELECT target_tenant_id, target_store_id, definition.kind, definition.code,
    definition.label, definition.description, definition.required_permissions,
    definition.sort_order, definition.config, 'active'
  FROM (VALUES
    ('approval_limit', 'order.discount', '订单折扣', '控制单次可优惠金额和最高折扣比例', ARRAY['order.discount']::text[], 10,
      '{"currency":"CNY","defaultRules":{"discountBasisPoints":1000,"requiresReason":true},"controls":["discount_percent"]}'::jsonb),
    ('approval_limit', 'order.gift', '赠送商品', '控制单次可赠送金额，赠送原因始终留痕', ARRAY['order.gift']::text[], 20,
      '{"currency":"CNY","defaultRules":{"allowFullGift":true,"requiresReason":true},"controls":[]}'::jsonb),
    ('approval_limit', 'refund.approve', '退款审批', '控制单次可审批退款金额，执行退款仍需人工操作', ARRAY['refund.approve']::text[], 30,
      '{"currency":"CNY","defaultRules":{"requiresSecondActor":true,"requiresReason":true},"controls":["second_actor"]}'::jsonb),
    ('data_scope', 'kds.station_codes', '可制作出品站', '限制岗位可制作的吧台、后厨或收银档口', ARRAY['kds.prepare','kds.exception.manage']::text[], 110,
      '{"editor":"multi_choice","effect":"include","options":["bar","kitchen","cashier"]}'::jsonb),
    ('data_scope', 'reservation.visibility', '预约可见范围', '允许岗位查看全店预约', ARRAY['reservation.view','reservation.manage','reservation.view.all']::text[], 120,
      '{"editor":"boolean","effect":"include","enabledValue":"all"}'::jsonb),
    ('data_scope', 'reservation.area_ids', '预约区域', '限制岗位可查看的预约区域', ARRAY['reservation.view','reservation.manage']::text[], 130,
      '{"editor":"area_multi","effect":"include"}'::jsonb),
    ('data_scope', 'commercial.employee_ids', '可查看员工销售', '限制岗位可查看销售数据的员工范围', ARRAY['commercial.sales.view']::text[], 140,
      '{"editor":"employee_multi","effect":"include","disabledWhenAnyPermission":["commercial.sales.view_all"]}'::jsonb),
    ('navigation', 'live', '现场', '桌台、开台和现场调度', ARRAY['dashboard.view','table.view_all','table.open']::text[], 210, '{"route":"/staff/live"}'::jsonb),
    ('navigation', 'tasks', '任务', '服务需求与执行任务', ARRAY['service.view','service.execute','service.manage']::text[], 220, '{"route":"/staff/tasks"}'::jsonb),
    ('navigation', 'commerce', '出品', '点单、制作与配送', ARRAY['order.view','order.create','kds.prepare','kds.deliver','fulfillment.view_all']::text[], 230, '{"route":"/staff/fulfillment"}'::jsonb),
    ('navigation', 'reservations', '预约', '预约处理与配置', ARRAY['reservation.view','reservation.view.all','reservation.manage','reservation.config.manage']::text[], 240, '{"route":"/staff/reservations"}'::jsonb),
    ('navigation', 'payments', '收银', '收款、退款与对账', ARRAY['payment.initiate.staff','payment.manual.cash.record','payment.manual.pos.record','refund.request','refund.approve','refund.execute','reconciliation.view']::text[], 250, '{"route":"/staff/payments"}'::jsonb),
    ('navigation', 'inventory', '库存', '库存、入库与成本', ARRAY['inventory.view','inventory.manage','inventory.cost.view']::text[], 260, '{"route":"/staff/inventory"}'::jsonb),
    ('navigation', 'performance', '演出', '演出排班与点歌', ARRAY['song.view','song.manage']::text[], 270, '{"route":"/staff/performance"}'::jsonb),
    ('navigation', 'operations', '经营数据', '销售、成本与利润', ARRAY['commercial.sales.view','commercial.sales.view_all','commercial.profit.view','commercial.cost.manage']::text[], 280, '{"route":"/staff/operations"}'::jsonb),
    ('navigation', 'devices', '设备', '打印机、耳机和摄像头设备', ARRAY['hardware.view_all','hardware.manage','print.view_all']::text[], 290, '{"route":"/staff/devices"}'::jsonb),
    ('navigation', 'settings', '系统配置', '权限、设备与AI配置', ARRAY['staff.access.configure','hardware.manage','ai.schedule']::text[], 300, '{"route":"/staff/settings"}'::jsonb)
  ) AS definition(kind, code, label, description, required_permissions, sort_order, config)
  ON CONFLICT (tenant_id, store_id, definition_kind, code) DO UPDATE
  SET label = EXCLUDED.label,
      description = EXCLUDED.description,
      required_permission_codes = EXCLUDED.required_permission_codes,
      sort_order = EXCLUDED.sort_order,
      config = EXCLUDED.config,
      status = 'active',
      updated_at = clock_timestamp();
END;
$$;

CREATE OR REPLACE FUNCTION mbox.seed_store_staff_access_configuration_definitions()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM mbox.seed_staff_access_configuration_definitions(NEW.tenant_id, NEW.id);
  RETURN NEW;
END;
$$;

CREATE TRIGGER stores_seed_staff_access_configuration_definitions
  AFTER INSERT ON mbox.stores
  FOR EACH ROW EXECUTE FUNCTION mbox.seed_store_staff_access_configuration_definitions();

SELECT mbox.seed_staff_access_configuration_definitions(store.tenant_id, store.id)
FROM mbox.stores store;

COMMENT ON TABLE mbox.staff_access_configuration_definitions IS
  'Server-owned configurable catalog for approval, data-scope, and staff navigation editors.';

COMMIT;
