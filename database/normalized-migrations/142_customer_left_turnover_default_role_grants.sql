BEGIN;

-- 140 introduced the customer-left turnover operation and seeded its default
-- grants. Store provisioning is authoritative, though: an older provision
-- manifest removed that seeded assignment on every release. Reassert the
-- operational default for existing stores while the v17 manifest keeps it on
-- subsequent provisioning runs. Administrators may still revoke or delegate
-- this capability through normal staff-access management.
INSERT INTO mbox.staff_permission_definitions (
  tenant_id,store_id,code,name,category,description,status
)
SELECT store.tenant_id,store.id,'table.turnover_unsettled','顾客离店异常翻台','table',
  '未收到明确成功收款时，取消未履约部分、保留晚到支付事实并允许本桌翻台','active'
FROM mbox.stores AS store
ON CONFLICT (tenant_id,store_id,code) DO UPDATE SET
  name=EXCLUDED.name,
  category=EXCLUDED.category,
  description=EXCLUDED.description,
  status='active';

INSERT INTO mbox.role_permission_assignments(tenant_id,store_id,role_id,permission_id)
SELECT role.tenant_id,role.store_id,role.id,permission.id
FROM mbox.roles AS role
JOIN mbox.staff_permission_definitions AS permission
  ON permission.tenant_id=role.tenant_id
 AND permission.store_id=role.store_id
 AND permission.code='table.turnover_unsettled'
 AND permission.status='active'
WHERE role.code IN ('OWNER','OPS_LEAD','MANAGER','DEPUT_MANAGER','SERVER')
ON CONFLICT (tenant_id,store_id,role_id,permission_id) DO NOTHING;

UPDATE mbox.normalized_schema_metadata
SET schema_version='142',updated_at=clock_timestamp()
WHERE singleton=true AND schema_flavor='normalized-core-v1';

COMMIT;
