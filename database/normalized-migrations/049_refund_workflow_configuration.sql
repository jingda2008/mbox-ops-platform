BEGIN;

CREATE OR REPLACE FUNCTION mbox.seed_refund_workflow_configuration(
  target_tenant_id uuid,
  target_store_id uuid
) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO mbox.staff_permission_definitions (
    tenant_id, store_id, code, name, category, description, status
  ) VALUES
    (target_tenant_id, target_store_id, 'refund.request', '发起退款', 'payment',
      '发起退款申请；默认由店长岗位承担，必须由另一名有复核权限的员工处理', 'active'),
    (target_tenant_id, target_store_id, 'refund.approve', '复核退款', 'payment',
      '复核或驳回退款申请；默认由收银岗位承担，不能复核本人发起的退款', 'active'),
    (target_tenant_id, target_store_id, 'refund.execute', '执行退款', 'payment',
      '执行已复核通过的退款；默认由收银岗位承担，渠道成功前不得记为已退款', 'active')
  ON CONFLICT (tenant_id, store_id, code) DO UPDATE
  SET name=EXCLUDED.name,
      category=EXCLUDED.category,
      description=EXCLUDED.description,
      status='active';

  INSERT INTO mbox.staff_access_configuration_definitions (
    tenant_id, store_id, definition_kind, code, label, description,
    required_permission_codes, sort_order, config, status
  ) VALUES
    (target_tenant_id, target_store_id, 'approval_limit', 'refund.request',
      '退款发起额度', '控制单次可发起退款的金额；岗位权限和额度可配置，申请与复核始终分离',
      ARRAY['refund.request']::text[], 25,
      '{"currency":"CNY","defaultRules":{"requiresReason":true},"controls":[]}'::jsonb, 'active'),
    (target_tenant_id, target_store_id, 'approval_limit', 'refund.approve',
      '退款复核额度', '控制单次可复核退款的金额；复核人与发起人必须为不同员工',
      ARRAY['refund.approve']::text[], 30,
      '{"currency":"CNY","defaultRules":{"requiresSecondActor":true,"requiresReason":true},"controls":["second_actor"]}'::jsonb, 'active')
  ON CONFLICT (tenant_id, store_id, definition_kind, code) DO UPDATE
  SET label=EXCLUDED.label,
      description=EXCLUDED.description,
      required_permission_codes=EXCLUDED.required_permission_codes,
      sort_order=EXCLUDED.sort_order,
      config=EXCLUDED.config,
      status='active',
      updated_at=clock_timestamp();
END;
$$;

CREATE OR REPLACE FUNCTION mbox.seed_store_refund_workflow_configuration()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM mbox.seed_refund_workflow_configuration(NEW.tenant_id, NEW.id);
  RETURN NEW;
END;
$$;

CREATE TRIGGER zzz_stores_seed_refund_workflow_configuration
  AFTER INSERT ON mbox.stores
  FOR EACH ROW EXECUTE FUNCTION mbox.seed_store_refund_workflow_configuration();

SELECT mbox.seed_refund_workflow_configuration(store.tenant_id, store.id)
FROM mbox.stores store;

COMMENT ON FUNCTION mbox.seed_refund_workflow_configuration(uuid, uuid) IS
  'Seeds the configurable manager-request and cashier-review refund workflow catalog.';

COMMIT;
