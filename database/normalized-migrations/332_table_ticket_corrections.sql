BEGIN;
SET LOCAL lock_timeout='3s';
CREATE TABLE mbox.table_ticket_corrections(
 tenant_id uuid NOT NULL,store_id uuid NOT NULL,id uuid PRIMARY KEY DEFAULT gen_random_uuid(),ticket_id uuid NOT NULL,
 original_lot_id uuid NOT NULL,replacement_lot_id uuid,target_membership_id uuid NOT NULL,
 requested_by uuid NOT NULL,requested_at timestamptz NOT NULL DEFAULT clock_timestamp(),reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 3 AND 240),
 status text NOT NULL DEFAULT 'requested' CHECK(status IN('requested','approved','rejected')),decided_by uuid,decided_at timestamptz,
 CHECK((status='requested' AND decided_by IS NULL AND decided_at IS NULL) OR (status<>'requested' AND decided_by<>requested_by AND decided_by IS NOT NULL AND decided_at IS NOT NULL)),
 FOREIGN KEY(tenant_id,store_id,ticket_id) REFERENCES mbox.table_tickets(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,store_id,original_lot_id) REFERENCES mbox.loyalty_point_lots(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,store_id,replacement_lot_id) REFERENCES mbox.loyalty_point_lots(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,store_id,target_membership_id) REFERENCES mbox.customer_memberships(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,store_id,requested_by) REFERENCES mbox.employees(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,store_id,decided_by) REFERENCES mbox.employees(tenant_id,store_id,id)
);
CREATE UNIQUE INDEX ticket_correction_one_open ON mbox.table_ticket_corrections(tenant_id,store_id,ticket_id) WHERE status='requested';
ALTER TABLE mbox.table_ticket_corrections ENABLE ROW LEVEL SECURITY;
ALTER TABLE mbox.table_ticket_corrections FORCE ROW LEVEL SECURITY;
CREATE POLICY scoped ON mbox.table_ticket_corrections USING(tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id())
 WITH CHECK(tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id());
GRANT SELECT,INSERT,UPDATE(status,decided_at,decided_by,replacement_lot_id) ON mbox.table_ticket_corrections TO mbox_runtime;
UPDATE mbox.normalized_schema_metadata SET schema_version='332',updated_at=clock_timestamp() WHERE singleton;
COMMIT;
