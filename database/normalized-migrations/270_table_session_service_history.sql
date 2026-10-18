BEGIN;
ALTER TABLE mbox.table_sessions ADD COLUMN primary_service_employee_id uuid,
 ADD COLUMN service_revision integer NOT NULL DEFAULT 0 CHECK(service_revision>=0),
 ADD FOREIGN KEY(tenant_id,store_id,primary_service_employee_id) REFERENCES mbox.employees(tenant_id,store_id,id);
GRANT UPDATE(primary_service_employee_id,service_revision) ON mbox.table_sessions TO mbox_runtime;
-- Historical NULLs mean unknown. Never infer a past server from the person who opened a table.
CREATE TABLE mbox.table_session_service_changes (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, store_id uuid NOT NULL,
 table_session_id uuid NOT NULL, revision integer NOT NULL CHECK(revision>=0),
 from_employee_id uuid, to_employee_id uuid NOT NULL, actor_employee_id uuid NOT NULL,
 from_name text, to_name text NOT NULL, actor_name text NOT NULL,
 reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 2 AND 1000),
 occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(tenant_id,store_id,table_session_id,revision),
 FOREIGN KEY(tenant_id,store_id,table_session_id) REFERENCES mbox.table_sessions(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,store_id,from_employee_id) REFERENCES mbox.employees(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,store_id,to_employee_id) REFERENCES mbox.employees(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,store_id,actor_employee_id) REFERENCES mbox.employees(tenant_id,store_id,id)
);
ALTER TABLE mbox.table_session_service_changes ENABLE ROW LEVEL SECURITY;
ALTER TABLE mbox.table_session_service_changes FORCE ROW LEVEL SECURITY;
CREATE POLICY scoped ON mbox.table_session_service_changes
 USING(tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id())
 WITH CHECK(tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id());
REVOKE ALL ON mbox.table_session_service_changes FROM PUBLIC;
GRANT SELECT,INSERT ON mbox.table_session_service_changes TO mbox_runtime;
CREATE TRIGGER table_service_changes_immutable BEFORE UPDATE OR DELETE ON mbox.table_session_service_changes
 FOR EACH ROW EXECUTE FUNCTION mbox.reject_row_change();
CREATE FUNCTION mbox.resolve_table_primary(p_tenant uuid,p_store uuid,p_table uuid,p_employee uuid)
 RETURNS uuid LANGUAGE plpgsql SET search_path=pg_catalog,mbox AS $$
DECLARE chosen uuid; candidates uuid[];
BEGIN
 chosen:=p_employee;
 IF chosen IS NULL THEN
  SELECT array_agg(DISTINCT a.employee_id) INTO candidates FROM mbox.table_assignments a
   JOIN mbox.employees e ON (e.tenant_id,e.store_id,e.id)=(a.tenant_id,a.store_id,a.employee_id)
   WHERE a.tenant_id=p_tenant AND a.store_id=p_store AND a.table_id=p_table
    AND a.assignment_type='primary' AND a.starts_at<=clock_timestamp()
    AND (a.ends_at IS NULL OR a.ends_at>clock_timestamp()) AND e.status='active';
  IF cardinality(candidates)=1 THEN chosen:=candidates[1]; END IF;
 END IF;
 IF chosen IS NULL THEN RAISE EXCEPTION '开台必须明确主服务员，请先选择或安排责任桌' USING ERRCODE='P2701'; END IF;
 PERFORM 1 FROM mbox.employees WHERE tenant_id=p_tenant AND store_id=p_store AND id=chosen AND status='active' FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION '主服务员必须是本门店在职员工，请重新选择' USING ERRCODE='P2701'; END IF;
 RETURN chosen;
END $$;
REVOKE ALL ON FUNCTION mbox.resolve_table_primary(uuid,uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mbox.resolve_table_primary(uuid,uuid,uuid,uuid) TO mbox_runtime;
CREATE FUNCTION mbox.record_table_service_open() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,mbox AS $$
BEGIN
 IF NEW.primary_service_employee_id IS NOT NULL THEN
  IF NEW.opened_by_employee_id IS NULL THEN RAISE EXCEPTION '明确主服务员的开台必须记录操作员工' USING ERRCODE='P2701'; END IF;
  PERFORM mbox.resolve_table_primary(NEW.tenant_id,NEW.store_id,NEW.table_id,NEW.primary_service_employee_id);
  INSERT INTO mbox.table_session_service_changes(tenant_id,store_id,table_session_id,revision,to_employee_id,actor_employee_id,to_name,actor_name,reason,occurred_at)
   SELECT NEW.tenant_id,NEW.store_id,NEW.id,0,NEW.primary_service_employee_id,NEW.opened_by_employee_id,e.display_name,a.display_name,'开台确认主服务员',NEW.opened_at
   FROM mbox.employees e JOIN mbox.employees a ON (a.tenant_id,a.store_id,a.id)=(NEW.tenant_id,NEW.store_id,NEW.opened_by_employee_id)
   WHERE (e.tenant_id,e.store_id,e.id)=(NEW.tenant_id,NEW.store_id,NEW.primary_service_employee_id);
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER table_service_open AFTER INSERT ON mbox.table_sessions FOR EACH ROW EXECUTE FUNCTION mbox.record_table_service_open();
CREATE FUNCTION mbox.guard_table_service_change() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,mbox AS $$
DECLARE s mbox.table_sessions;
BEGIN
 SELECT * INTO STRICT s FROM mbox.table_sessions WHERE (tenant_id,store_id,id)=(NEW.tenant_id,NEW.store_id,NEW.table_session_id) FOR UPDATE;
 IF NEW.revision=0 THEN
  IF s.service_revision<>0 OR s.primary_service_employee_id IS DISTINCT FROM NEW.to_employee_id OR NEW.from_employee_id IS NOT NULL
   THEN RAISE EXCEPTION 'invalid initial service owner' USING ERRCODE='23514'; END IF;
 ELSE
  IF s.status<>'open' OR NEW.revision<>s.service_revision+1 OR NEW.from_employee_id IS DISTINCT FROM s.primary_service_employee_id
   OR NEW.to_employee_id IS NOT DISTINCT FROM s.primary_service_employee_id THEN
   RAISE EXCEPTION '桌次或服务负责人已变化，请刷新后重新交接' USING ERRCODE='P2702'; END IF;
 END IF;
 PERFORM mbox.resolve_table_primary(NEW.tenant_id,NEW.store_id,s.table_id,NEW.to_employee_id);
 SELECT display_name INTO STRICT NEW.to_name FROM mbox.employees WHERE (tenant_id,store_id,id)=(NEW.tenant_id,NEW.store_id,NEW.to_employee_id);
 SELECT display_name INTO STRICT NEW.actor_name FROM mbox.employees WHERE (tenant_id,store_id,id)=(NEW.tenant_id,NEW.store_id,NEW.actor_employee_id) AND status='active';
 SELECT display_name INTO NEW.from_name FROM mbox.employees WHERE (tenant_id,store_id,id)=(NEW.tenant_id,NEW.store_id,NEW.from_employee_id);
 RETURN NEW;
END $$;
CREATE TRIGGER table_service_change_guard BEFORE INSERT ON mbox.table_session_service_changes FOR EACH ROW EXECUTE FUNCTION mbox.guard_table_service_change();
CREATE FUNCTION mbox.apply_table_service_change() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,mbox AS $$
BEGIN
 IF NEW.revision>0 THEN UPDATE mbox.table_sessions SET primary_service_employee_id=NEW.to_employee_id,service_revision=NEW.revision
  WHERE (tenant_id,store_id,id)=(NEW.tenant_id,NEW.store_id,NEW.table_session_id); END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER table_service_change_apply AFTER INSERT ON mbox.table_session_service_changes FOR EACH ROW EXECUTE FUNCTION mbox.apply_table_service_change();
CREATE FUNCTION mbox.guard_table_service_pointer() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,mbox AS $$
BEGIN
 IF (NEW.primary_service_employee_id,NEW.service_revision) IS DISTINCT FROM (OLD.primary_service_employee_id,OLD.service_revision) AND NOT EXISTS(
  SELECT 1 FROM mbox.table_session_service_changes e WHERE (e.tenant_id,e.store_id,e.table_session_id,e.revision)=(NEW.tenant_id,NEW.store_id,NEW.id,NEW.service_revision)
   AND e.to_employee_id=NEW.primary_service_employee_id AND e.from_employee_id IS NOT DISTINCT FROM OLD.primary_service_employee_id AND NEW.service_revision=OLD.service_revision+1
 ) THEN RAISE EXCEPTION '服务负责人变更必须保留交接记录' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER table_service_pointer_guard BEFORE UPDATE ON mbox.table_sessions FOR EACH ROW EXECUTE FUNCTION mbox.guard_table_service_pointer();
-- A split is a new table session. Carry the explicitly confirmed source owner;
-- legacy unknown owners must first be confirmed or the target must have one primary assignment.
DO $$ DECLARE source text; changed text; function_oid oid;
BEGIN
 SELECT oid INTO STRICT function_oid FROM pg_proc WHERE pronamespace='mbox'::regnamespace AND proname='execute_table_customer_movement';
 source:=pg_get_functiondef(function_oid);
 changed:=replace(source,'status,opened_by_employee_id'||chr(10)||'      ) VALUES (','status,opened_by_employee_id,primary_service_employee_id'||chr(10)||'      ) VALUES (');
 changed:=replace(changed,'''{}'',''open'',requested_actor_employee_id'||chr(10)||'      ) RETURNING * INTO target_session;',
 '''{}'',''open'',requested_actor_employee_id,mbox.resolve_table_primary(tenant_id_value,store_id_value,target_table.id,source_session.primary_service_employee_id)'||chr(10)||'      ) RETURNING * INTO target_session;');
 IF changed=source OR position('source_session.primary_service_employee_id' IN changed)=0 THEN RAISE EXCEPTION 'split owner patch not applied'; END IF;
 EXECUTE changed;
END $$;
UPDATE mbox.normalized_schema_metadata SET schema_version='270',updated_at=clock_timestamp() WHERE singleton=true;
COMMIT;
