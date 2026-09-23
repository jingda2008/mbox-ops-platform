BEGIN;

CREATE TABLE mbox.staff_access_revisions (
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  PRIMARY KEY (tenant_id, store_id),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id)
);
CREATE TABLE mbox.staff_permission_deployment_receipts (
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  actor_employee_id uuid NOT NULL,
  operation_key text NOT NULL CHECK (length(operation_key) BETWEEN 8 AND 160),
  request_sha256 text NOT NULL CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
  result jsonb NOT NULL CHECK (jsonb_typeof(result) = 'object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, store_id, actor_employee_id, operation_key),
  FOREIGN KEY (tenant_id, store_id, actor_employee_id) REFERENCES mbox.employees(tenant_id, store_id, id)
);
CREATE TRIGGER staff_permission_receipts_immutable BEFORE UPDATE OR DELETE ON mbox.staff_permission_deployment_receipts
  FOR EACH ROW EXECUTE FUNCTION mbox.reject_row_change();

DO $$ DECLARE relation text; BEGIN
  FOREACH relation IN ARRAY ARRAY['staff_access_revisions','staff_permission_deployment_receipts'] LOOP
    EXECUTE format('ALTER TABLE mbox.%I ENABLE ROW LEVEL SECURITY',relation);
    EXECUTE format('ALTER TABLE mbox.%I FORCE ROW LEVEL SECURITY',relation);
    EXECUTE format('CREATE POLICY tenant_store_isolation ON mbox.%I USING (tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id()) WITH CHECK (tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id())',relation);
    EXECUTE format('REVOKE ALL ON mbox.%I FROM PUBLIC',relation);
    EXECUTE format('GRANT SELECT,INSERT ON mbox.%I TO mbox_runtime',relation);
  END LOOP;
END $$;
GRANT UPDATE(revision) ON mbox.staff_access_revisions TO mbox_runtime;

-- All configuration writers, including the older repository entry points, advance
-- the same revision. Reverting to an earlier value still invalidates stale pages.
CREATE FUNCTION mbox.advance_staff_access_revision() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE changed_tenant uuid; changed_store uuid;
BEGIN
  IF TG_OP='DELETE' THEN changed_tenant:=OLD.tenant_id; changed_store:=OLD.store_id;
  ELSE changed_tenant:=NEW.tenant_id; changed_store:=NEW.store_id; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('staff-access:'||changed_tenant::text||':'||changed_store::text,0));
  INSERT INTO mbox.staff_access_revisions(tenant_id,store_id,revision) VALUES(changed_tenant,changed_store,1)
    ON CONFLICT(tenant_id,store_id) DO UPDATE SET revision=mbox.staff_access_revisions.revision+1;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END;
$$;
DO $$ DECLARE relation text; BEGIN
  FOREACH relation IN ARRAY ARRAY[
    'staff_permission_definitions','role_permission_assignments','employee_permission_overrides',
    'role_data_scopes','role_approval_limits','role_navigation_items','roles','employees','employee_roles',
    'staff_access_configuration_definitions','role_access_configuration_authorities'
  ] LOOP
    EXECUTE format('CREATE TRIGGER staff_access_revision BEFORE INSERT OR UPDATE OR DELETE ON mbox.%I FOR EACH ROW EXECUTE FUNCTION mbox.advance_staff_access_revision()',relation);
  END LOOP;
END $$;

-- Readiness must inspect schema identity through the least-privileged runtime login.
-- Migration ownership and write privileges remain with the maintenance login.
GRANT SELECT ON mbox.normalized_schema_metadata, mbox.normalized_schema_migrations TO mbox_runtime;
-- FOR KEY SHARE by turnover/business-day workers requires UPDATE on a column.
GRANT UPDATE(updated_at) ON mbox.stores TO mbox_runtime;

UPDATE mbox.normalized_schema_metadata SET schema_version='227',updated_at=clock_timestamp()
WHERE singleton=true AND schema_flavor='normalized-core-v1';
COMMIT;
