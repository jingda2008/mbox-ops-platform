BEGIN;

-- Cashiers own the payment exception workflow. Let that role create an
-- assisted order, see the tables whose payments they own, and release a
-- physical table after the customer leaves,
-- without granting catalog administration, gifts, refund requests, or any
-- ability to rewrite an unknown provider result as paid. Both turnover
-- permissions remain subject to table access checks, a required reason,
-- idempotency, and the append-only customer-left audit event.
INSERT INTO mbox.role_permission_assignments(tenant_id,store_id,role_id,permission_id)
SELECT role.tenant_id,role.store_id,role.id,permission.id
FROM mbox.roles AS role
JOIN mbox.staff_permission_definitions AS permission
  ON permission.tenant_id=role.tenant_id
 AND permission.store_id=role.store_id
 AND permission.code IN ('order.create','table.view_all','table.close','table.turnover_unsettled')
 AND permission.status='active'
WHERE role.status='active' AND role.code='CASHIER'
ON CONFLICT(tenant_id,store_id,role_id,permission_id) DO NOTHING;

UPDATE mbox.normalized_schema_metadata
SET schema_version='157',updated_at=clock_timestamp()
WHERE singleton=true AND schema_flavor='normalized-core-v1';

COMMIT;
