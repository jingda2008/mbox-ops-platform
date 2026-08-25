BEGIN;

-- Member work is split by least privilege. A redemption employee must not gain
-- account lookup or policy controls merely because the old experience page
-- happened to contain every loyalty panel.
CREATE OR REPLACE FUNCTION mbox.seed_member_staff_navigation_definitions(
  target_tenant_id uuid,
  target_store_id uuid
) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO mbox.staff_access_configuration_definitions (
    tenant_id, store_id, definition_kind, code, label, description,
    required_permission_codes, sort_order, config, status
  )
  SELECT target_tenant_id, target_store_id, 'navigation', definition.code,
    definition.label, definition.description, definition.required_permissions,
    definition.sort_order, definition.config, 'active'
  FROM (VALUES
    (
      'member-fulfillment', '会员权益待办',
      '当前桌次赠品、积分兑换和年度礼遇的确认与履约',
      ARRAY['loyalty.redemption.fulfill']::text[],
      286, '{"route":"/staff/member-fulfillment"}'::jsonb
    ),
    (
      'member-exceptions', '会员权益异常',
      '处理过期、缺货、结果未知、积分不一致和核销异常',
      ARRAY['loyalty.redemption.exception','loyalty.accrual.exception.view']::text[],
      287, '{"route":"/staff/member-exceptions"}'::jsonb
    ),
    (
      'member-management', '会员等级与权益',
      '会员账户查询、等级积分政策、年度礼遇和会员条款管理',
      ARRAY[
        'loyalty.operations.view','loyalty.operations.control',
        'loyalty.configuration.view','loyalty.configuration.edit','loyalty.configuration.preview','loyalty.configuration.approve',
        'loyalty.promotion.view','loyalty.promotion.manage','loyalty.promotion.approve','loyalty.promotion.publish',
        'loyalty.policy.view','loyalty.policy.manage','loyalty.policy.approve','loyalty.policy.publish',
        'loyalty.account.view',
        'loyalty.annual-benefit.view','loyalty.annual-benefit.manage','loyalty.annual-benefit.approve',
        'loyalty.annual-benefit.publish','loyalty.annual-benefit.occurrence.confirm',
        'loyalty.redemption.catalog.manage','loyalty.redemption.catalog.approve',
        'loyalty.redemption.catalog.publish','loyalty.redemption.control',
        'loyalty.accrual.request','loyalty.accrual.approve',
        'membership.terms.view','membership.terms.manage','membership.terms.approve','membership.terms.publish',
        'customer.membership.recovery.verify','customer.membership.merge.approve'
      ]::text[],
      288, '{"route":"/staff/member-management"}'::jsonb
    )
  ) AS definition(code, label, description, required_permissions, sort_order, config)
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

CREATE OR REPLACE FUNCTION mbox.seed_store_member_staff_navigation_definitions()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM mbox.seed_member_staff_navigation_definitions(NEW.tenant_id, NEW.id);
  RETURN NEW;
END;
$$;

CREATE TRIGGER zz_stores_seed_member_staff_navigation_definitions
  AFTER INSERT ON mbox.stores
  FOR EACH ROW EXECUTE FUNCTION mbox.seed_store_member_staff_navigation_definitions();

SELECT mbox.seed_member_staff_navigation_definitions(store.tenant_id, store.id)
FROM mbox.stores store;

UPDATE mbox.normalized_schema_metadata
SET schema_version='117', updated_at=clock_timestamp()
WHERE singleton=true AND schema_flavor='normalized-core-v1';

COMMIT;
