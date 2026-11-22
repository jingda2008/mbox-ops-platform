BEGIN;
SET LOCAL lock_timeout='3s';
CREATE TABLE mbox.assisted_points_proposals(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL,store_id uuid NOT NULL,table_session_id uuid NOT NULL,
 customer_id uuid NOT NULL,employee_id uuid NOT NULL,lines jsonb NOT NULL CHECK(jsonb_typeof(lines)='array'),
 points integer NOT NULL CHECK(points>0),subtotal_minor bigint NOT NULL CHECK(subtotal_minor>=points::bigint*100),
 location_version bigint NOT NULL,cart_generation bigint NOT NULL,cart_version bigint NOT NULL,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN('pending','adopted','superseded')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '10 minutes',
 FOREIGN KEY(tenant_id,store_id,table_session_id) REFERENCES mbox.table_sessions(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,store_id,customer_id) REFERENCES mbox.customers(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,store_id,employee_id) REFERENCES mbox.employees(tenant_id,store_id,id)
);
CREATE UNIQUE INDEX pending_assisted_points_per_table ON mbox.assisted_points_proposals(tenant_id,store_id,table_session_id)
 WHERE status='pending';
ALTER TABLE mbox.assisted_points_proposals ENABLE ROW LEVEL SECURITY;
ALTER TABLE mbox.assisted_points_proposals FORCE ROW LEVEL SECURITY;
CREATE POLICY scoped ON mbox.assisted_points_proposals USING
 (tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id()) WITH CHECK(tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id());
GRANT SELECT,INSERT,UPDATE(status) ON mbox.assisted_points_proposals TO mbox_runtime;
UPDATE mbox.normalized_schema_metadata SET schema_version='331',updated_at=clock_timestamp() WHERE singleton;
COMMIT;
