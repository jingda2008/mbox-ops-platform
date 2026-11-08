BEGIN;
CREATE TABLE mbox.table_credit_order_links (
 tenant_id uuid NOT NULL,store_id uuid NOT NULL,table_session_id uuid NOT NULL,order_id uuid NOT NULL,employee_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(tenant_id,store_id,order_id),
 FOREIGN KEY(tenant_id,store_id,order_id) REFERENCES mbox.orders(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,store_id,table_session_id) REFERENCES mbox.table_sessions(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,store_id,employee_id) REFERENCES mbox.employees(tenant_id,store_id,id)
);
ALTER TABLE mbox.table_credit_order_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE mbox.table_credit_order_links FORCE ROW LEVEL SECURITY;
CREATE POLICY table_credit_scope ON mbox.table_credit_order_links USING(tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id()) WITH CHECK(tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id());
GRANT SELECT,INSERT ON mbox.table_credit_order_links TO mbox_runtime;
CREATE TRIGGER immutable_credit_order_link BEFORE UPDATE OR DELETE ON mbox.table_credit_order_links FOR EACH ROW EXECUTE FUNCTION mbox.reject_row_change();
CREATE FUNCTION mbox.staff_can_collect_table_credit(t uuid,s uuid,p_session uuid,p_employee uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog,mbox AS $$
 SELECT mbox.employee_has_effective_permission(t,s,p_employee,'payment.initiate.staff') AND EXISTS(
 SELECT 1 FROM mbox.table_sessions visit JOIN mbox.employees employee ON(employee.tenant_id,employee.store_id,employee.id)=(visit.tenant_id,visit.store_id,p_employee)
 WHERE(visit.tenant_id,visit.store_id,visit.id)=(t,s,p_session) AND visit.status='open' AND employee.status='active'
 AND(mbox.employee_has_effective_permission(t,s,p_employee,'payment.collect.all_tables') OR EXISTS(SELECT 1 FROM mbox.table_assignments a WHERE(a.tenant_id,a.store_id,a.table_id,a.employee_id)=(t,s,visit.table_id,p_employee) AND a.assignment_type IN('primary','backup') AND a.starts_at<=statement_timestamp() AND(a.ends_at IS NULL OR a.ends_at>statement_timestamp()))))
$$;
REVOKE ALL ON FUNCTION mbox.staff_can_collect_table_credit(uuid,uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mbox.staff_can_collect_table_credit(uuid,uuid,uuid,uuid) TO mbox_runtime;
CREATE FUNCTION mbox.guard_credit_order_link() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM 1 FROM mbox.table_sessions WHERE(tenant_id,store_id,id)=(NEW.tenant_id,NEW.store_id,NEW.table_session_id) AND status='open' FOR UPDATE;
 IF NOT FOUND OR NOT mbox.staff_can_collect_table_credit(NEW.tenant_id,NEW.store_id,NEW.table_session_id,NEW.employee_id)
 OR NOT EXISTS(SELECT 1 FROM mbox.orders WHERE(tenant_id,store_id,id,table_session_id)=(NEW.tenant_id,NEW.store_id,NEW.order_id,NEW.table_session_id) AND channel IN('staff_assisted','cashier') AND status NOT IN('draft','cancelled'))
 THEN RAISE EXCEPTION 'staff credit target or authority invalid' USING ERRCODE='42501';END IF;RETURN NEW;
END $$;
CREATE TRIGGER credit_order_link_guard BEFORE INSERT ON mbox.table_credit_order_links FOR EACH ROW EXECUTE FUNCTION mbox.guard_credit_order_link();
REVOKE ALL ON FUNCTION mbox.guard_credit_order_link() FROM PUBLIC;
CREATE FUNCTION mbox.enable_staff_table_credit(session_id uuid,employee_id uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,mbox AS $$
BEGIN
 IF NOT mbox.staff_can_collect_table_credit(mbox.current_tenant_id(),mbox.current_store_id(),session_id,employee_id) THEN RAISE EXCEPTION 'staff credit authority required' USING ERRCODE='42501';END IF;
 UPDATE mbox.table_sessions SET minimum_spend_mode='prepaid',credit_collection_enabled=true WHERE tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id() AND id=session_id AND status='open';
 IF NOT FOUND THEN RAISE EXCEPTION 'staff credit session ended' USING ERRCODE='23514';END IF;
END $$;
REVOKE ALL ON FUNCTION mbox.enable_staff_table_credit(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mbox.enable_staff_table_credit(uuid,uuid) TO mbox_runtime;
UPDATE mbox.normalized_schema_metadata SET schema_version='303',updated_at=clock_timestamp() WHERE singleton=true;
COMMIT;
