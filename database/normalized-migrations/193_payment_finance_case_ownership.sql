BEGIN;
CREATE TABLE mbox.payment_finance_cases (
 tenant_id uuid NOT NULL,store_id uuid NOT NULL,payment_id uuid NOT NULL,
 owner_employee_id uuid NOT NULL,status text NOT NULL DEFAULT 'reviewing' CHECK(status IN ('reviewing','resolved')),
 note text NOT NULL CHECK(length(btrim(note)) BETWEEN 3 AND 1000),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),resolved_at timestamptz,
 PRIMARY KEY(tenant_id,store_id,payment_id),
 FOREIGN KEY(tenant_id,store_id,payment_id) REFERENCES mbox.payments(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,store_id,owner_employee_id) REFERENCES mbox.employees(tenant_id,store_id,id),
 CHECK((status='resolved')=(resolved_at IS NOT NULL))
);
ALTER TABLE mbox.payment_finance_cases ENABLE ROW LEVEL SECURITY;
ALTER TABLE mbox.payment_finance_cases FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_store_isolation ON mbox.payment_finance_cases
 USING(tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id())
 WITH CHECK(tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id());
REVOKE ALL ON mbox.payment_finance_cases FROM PUBLIC;
GRANT SELECT,INSERT,UPDATE ON mbox.payment_finance_cases TO mbox_runtime;
UPDATE mbox.normalized_schema_metadata SET schema_version='193',updated_at=clock_timestamp() WHERE singleton=true;
COMMIT;
