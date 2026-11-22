BEGIN;
SET LOCAL lock_timeout='3s';
CREATE TABLE mbox.print_queue_observations (
 tenant_id uuid NOT NULL, store_id uuid NOT NULL, bridge_id uuid NOT NULL,
 queue_name text NOT NULL, checked_at timestamptz NOT NULL,
 received_at timestamptz NOT NULL DEFAULT clock_timestamp(), observation jsonb NOT NULL,
 PRIMARY KEY (tenant_id,store_id,bridge_id,queue_name),
 FOREIGN KEY (tenant_id,store_id,bridge_id) REFERENCES mbox.print_bridges(tenant_id,store_id,id),
 CHECK (jsonb_typeof(observation)='object')
);
ALTER TABLE mbox.print_queue_observations ENABLE ROW LEVEL SECURITY;
ALTER TABLE mbox.print_queue_observations FORCE ROW LEVEL SECURITY;
CREATE POLICY scoped ON mbox.print_queue_observations USING
 (tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id())
 WITH CHECK (tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id());
GRANT SELECT,INSERT,UPDATE(checked_at,received_at,observation) ON mbox.print_queue_observations TO mbox_runtime;
UPDATE mbox.normalized_schema_metadata SET schema_version='322',updated_at=clock_timestamp() WHERE singleton;
COMMIT;
