BEGIN;
CREATE TABLE mbox.social_broadcasts(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL,store_id uuid NOT NULL,account_id uuid NOT NULL,
 title text NOT NULL CHECK(length(title) BETWEEN 1 AND 80),content text NOT NULL CHECK(length(content) BETWEEN 1 AND 600),
 scheduled_at timestamptz NOT NULL,status text NOT NULL DEFAULT 'draft' CHECK(status IN('draft','scheduled','sending','accepted','rejected','unknown','cancelled','delivered','delivery_failed')),
 provider_reference text,error_code text,claimed_at timestamptz,completed_at timestamptz,
 created_by_employee_id uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(tenant_id,store_id,id),FOREIGN KEY(tenant_id,store_id,account_id) REFERENCES mbox.social_accounts(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,store_id,created_by_employee_id) REFERENCES mbox.employees(tenant_id,store_id,id)
);
CREATE INDEX social_broadcast_due ON mbox.social_broadcasts(tenant_id,store_id,scheduled_at) WHERE status='scheduled';
ALTER TABLE mbox.social_broadcasts ENABLE ROW LEVEL SECURITY;
ALTER TABLE mbox.social_broadcasts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_store_isolation ON mbox.social_broadcasts USING(tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id()) WITH CHECK(tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id());
REVOKE ALL ON mbox.social_broadcasts FROM PUBLIC,mbox_runtime;
GRANT SELECT,INSERT,UPDATE ON mbox.social_broadcasts TO mbox_runtime;
UPDATE mbox.normalized_schema_metadata SET schema_version='210',updated_at=clock_timestamp() WHERE singleton=true;
COMMIT;
