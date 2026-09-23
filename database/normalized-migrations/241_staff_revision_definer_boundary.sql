BEGIN;

-- Existing store seed functions may still belong to the retired migration
-- account. Their nested trigger must not depend on that account gaining access
-- to a table created later by the replacement maintenance account.
CREATE OR REPLACE FUNCTION mbox.advance_staff_access_revision()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,mbox AS $$
DECLARE changed_tenant uuid; changed_store uuid;
BEGIN
  -- A definer trigger must never be reusable on a caller-owned temporary table.
  IF TG_TABLE_SCHEMA<>'mbox' OR TG_WHEN<>'BEFORE' OR TG_LEVEL<>'ROW'
     OR TG_TABLE_NAME<>ALL(ARRAY[
       'staff_permission_definitions','role_permission_assignments','employee_permission_overrides',
       'role_data_scopes','role_approval_limits','role_navigation_items','roles','employees','employee_roles',
       'staff_access_configuration_definitions','role_access_configuration_authorities'
     ]) THEN
    RAISE EXCEPTION 'staff revision trigger requires an authoritative configuration table' USING ERRCODE='42501';
  END IF;
  IF TG_OP='DELETE' THEN changed_tenant:=OLD.tenant_id; changed_store:=OLD.store_id;
  ELSE changed_tenant:=NEW.tenant_id; changed_store:=NEW.store_id; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('staff-access:'||changed_tenant::text||':'||changed_store::text,0));
  INSERT INTO mbox.staff_access_revisions(tenant_id,store_id,revision) VALUES(changed_tenant,changed_store,1)
    ON CONFLICT(tenant_id,store_id) DO UPDATE SET revision=mbox.staff_access_revisions.revision+1;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END;
$$;
REVOKE ALL ON FUNCTION mbox.advance_staff_access_revision() FROM PUBLIC,mbox_runtime;

UPDATE mbox.normalized_schema_metadata SET schema_version='241',updated_at=clock_timestamp()
WHERE singleton=true AND schema_flavor='normalized-core-v1';
COMMIT;
