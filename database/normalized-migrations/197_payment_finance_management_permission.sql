BEGIN;
-- Case ownership and progress only. Collection/refund permissions are unchanged.
INSERT INTO mbox.staff_permission_definitions(tenant_id,store_id,code,name,category,description)
SELECT tenant_id,id,'reconciliation.manage','处理财务核对','finance','接手付款核对、记录进展和按账务事实结案；不授予收款或退款权限'
FROM mbox.stores ON CONFLICT(tenant_id,store_id,code) DO NOTHING;
INSERT INTO mbox.role_permission_assignments(tenant_id,store_id,role_id,permission_id)
SELECT r.tenant_id,r.store_id,r.id,manage.id FROM mbox.roles r
JOIN mbox.staff_permission_definitions view_permission ON view_permission.tenant_id=r.tenant_id AND view_permission.store_id=r.store_id AND view_permission.code='reconciliation.view' AND view_permission.status='active'
JOIN mbox.role_permission_assignments existing ON existing.tenant_id=r.tenant_id AND existing.store_id=r.store_id AND existing.role_id=r.id AND existing.permission_id=view_permission.id
JOIN mbox.staff_permission_definitions manage ON manage.tenant_id=r.tenant_id AND manage.store_id=r.store_id AND manage.code='reconciliation.manage' AND manage.status='active'
WHERE r.status='active' AND r.code IN ('CASHIER','MANAGER','OWNER','ADMIN')
ON CONFLICT(tenant_id,store_id,role_id,permission_id) DO NOTHING;
UPDATE mbox.normalized_schema_metadata SET schema_version='197',updated_at=clock_timestamp() WHERE singleton=true;
COMMIT;
