BEGIN;
-- Approval of a policy is distinct from coupon issuance and from consent.
ALTER TABLE mbox.stacking_pricing_drafts ADD COLUMN allow_checkout_upgrade boolean NOT NULL DEFAULT false;
CREATE TRIGGER stacking_drafts_append_only BEFORE UPDATE OR DELETE ON mbox.stacking_pricing_drafts FOR EACH ROW EXECUTE FUNCTION mbox.reject_row_change();
CREATE TABLE mbox.stacking_pricing_decisions(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL,store_id uuid NOT NULL,version_id uuid NOT NULL,
  action text NOT NULL CHECK(action IN('approve','publish','stop_issuing')),
  employee_id uuid NOT NULL,reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 2 AND 500),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(tenant_id,store_id,version_id,action),
  FOREIGN KEY(tenant_id,store_id,version_id) REFERENCES mbox.stacking_pricing_drafts(tenant_id,store_id,id),
  FOREIGN KEY(tenant_id,store_id,employee_id) REFERENCES mbox.employees(tenant_id,store_id,id)
);
CREATE FUNCTION mbox.validate_stacking_pricing_decision() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE author uuid;approver uuid;
BEGIN
  SELECT created_by_employee_id INTO author FROM mbox.stacking_pricing_drafts WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id AND id=NEW.version_id FOR UPDATE;
  IF author IS NULL THEN RAISE EXCEPTION 'Unknown stacking policy'; END IF;
  IF EXISTS(SELECT 1 FROM mbox.stacking_pricing_decisions WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id AND version_id=NEW.version_id AND action='stop_issuing') THEN RAISE EXCEPTION 'Stacking policy issuance is stopped'; END IF;
  IF NEW.action IN('approve','publish') AND NEW.employee_id=author THEN RAISE EXCEPTION 'Stacking author cannot approve or publish'; END IF;
  SELECT employee_id INTO approver FROM mbox.stacking_pricing_decisions WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id AND version_id=NEW.version_id AND action='approve';
  IF NEW.action='publish' AND (approver IS NULL OR approver=NEW.employee_id) THEN RAISE EXCEPTION 'Stacking policy requires three distinct actors'; END IF;
  IF NEW.action='stop_issuing' AND NOT EXISTS(SELECT 1 FROM mbox.stacking_pricing_decisions WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id AND version_id=NEW.version_id AND action='publish') THEN RAISE EXCEPTION 'Only published stacking policy can stop issuance'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER validate_stacking_pricing_decision BEFORE INSERT ON mbox.stacking_pricing_decisions FOR EACH ROW EXECUTE FUNCTION mbox.validate_stacking_pricing_decision();
CREATE TRIGGER stacking_decisions_append_only BEFORE UPDATE OR DELETE ON mbox.stacking_pricing_decisions FOR EACH ROW EXECUTE FUNCTION mbox.reject_row_change();
ALTER TABLE mbox.stacking_pricing_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE mbox.stacking_pricing_decisions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_store_isolation ON mbox.stacking_pricing_decisions USING(tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id()) WITH CHECK(tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id());
REVOKE ALL ON mbox.stacking_pricing_decisions FROM PUBLIC,mbox_runtime;
GRANT SELECT,INSERT ON mbox.stacking_pricing_decisions TO mbox_runtime;
REVOKE ALL ON FUNCTION mbox.validate_stacking_pricing_decision() FROM PUBLIC;
UPDATE mbox.normalized_schema_metadata SET schema_version='171',updated_at=clock_timestamp() WHERE singleton=true;
COMMIT;
