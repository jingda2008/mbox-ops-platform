BEGIN;

-- Service staff may start a customer-owned QR or payment-code collection for
-- an assigned table. This is narrower than cash/POS recording, refund,
-- settlement and reconciliation permissions. A personal deny still wins when
-- effective permissions are resolved at login and command time.
INSERT INTO mbox.role_permission_assignments(tenant_id,store_id,role_id,permission_id)
SELECT role.tenant_id,role.store_id,role.id,permission.id
FROM mbox.roles role
JOIN mbox.staff_permission_definitions permission
  ON permission.tenant_id=role.tenant_id AND permission.store_id=role.store_id
WHERE role.status='active'
  AND role.code='SERVER'
  AND permission.status='active'
  AND permission.code='payment.initiate.staff'
ON CONFLICT (tenant_id,store_id,role_id,permission_id) DO NOTHING;

UPDATE mbox.normalized_schema_metadata
SET schema_version='115',updated_at=clock_timestamp()
WHERE singleton=true AND schema_flavor='normalized-core-v1';

COMMIT;
