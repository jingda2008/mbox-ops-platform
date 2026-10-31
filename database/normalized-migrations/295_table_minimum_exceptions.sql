BEGIN;
CREATE TABLE mbox.order_minimum_spend_releases (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL,store_id uuid NOT NULL,
 table_session_id uuid NOT NULL,order_id uuid NOT NULL,employee_id uuid NOT NULL,
 reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 2 AND 500),
 minimum_minor bigint NOT NULL CHECK(minimum_minor>0),consumed_minor bigint NOT NULL CHECK(consumed_minor>=0),
 cart_minor bigint NOT NULL CHECK(cart_minor>=0),shortfall_minor bigint NOT NULL CHECK(shortfall_minor>0),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(tenant_id,store_id,order_id),
 CHECK(shortfall_minor=minimum_minor-consumed_minor-cart_minor),
 FOREIGN KEY(tenant_id,store_id,table_session_id) REFERENCES mbox.table_sessions(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,store_id,order_id) REFERENCES mbox.orders(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,store_id,employee_id) REFERENCES mbox.employees(tenant_id,store_id,id)
);
CREATE INDEX order_minimum_releases_session ON mbox.order_minimum_spend_releases(tenant_id,store_id,table_session_id);
ALTER TABLE mbox.order_minimum_spend_releases ENABLE ROW LEVEL SECURITY;
ALTER TABLE mbox.order_minimum_spend_releases FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_store_isolation ON mbox.order_minimum_spend_releases USING(tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id()) WITH CHECK(tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id());
REVOKE ALL ON mbox.order_minimum_spend_releases FROM PUBLIC;
GRANT SELECT,INSERT ON mbox.order_minimum_spend_releases TO mbox_runtime;
CREATE TRIGGER immutable_release BEFORE UPDATE OR DELETE ON mbox.order_minimum_spend_releases FOR EACH ROW EXECUTE FUNCTION mbox.reject_row_change();
CREATE FUNCTION mbox.guard_order_minimum_release() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM mbox.orders o JOIN mbox.table_sessions s ON(s.tenant_id,s.store_id,s.id)=(o.tenant_id,o.store_id,o.table_session_id)
 WHERE(o.tenant_id,o.store_id,o.id,o.table_session_id,o.created_by_employee_id)=(NEW.tenant_id,NEW.store_id,NEW.order_id,NEW.table_session_id,NEW.employee_id)
 AND o.channel='staff_assisted' AND s.minimum_spend_mode='order_gate' AND s.status='open'
 AND s.minimum_spend_minor-s.minimum_spend_waiver_minor=NEW.minimum_minor) THEN
 RAISE EXCEPTION 'minimum release must match staff order and current table minimum' USING ERRCODE='23514';END IF;
 RETURN NEW;END $$;
CREATE TRIGGER guard_order_minimum_release BEFORE INSERT ON mbox.order_minimum_spend_releases FOR EACH ROW EXECUTE FUNCTION mbox.guard_order_minimum_release();
ALTER TABLE mbox.table_minimum_spend_waivers ADD COLUMN before_minimum_minor bigint,ADD COLUMN after_minimum_minor bigint,
 ADD CHECK(before_minimum_minor IS NULL OR (before_minimum_minor>after_minimum_minor AND after_minimum_minor>=0 AND before_minimum_minor-after_minimum_minor=amount_minor));
-- Old records remain original evidence. New records capture the locked current threshold.
CREATE FUNCTION mbox.snapshot_minimum_waiver() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE current_minimum bigint;BEGIN
 SELECT minimum_spend_minor-minimum_spend_waiver_minor INTO current_minimum FROM mbox.table_sessions
 WHERE(tenant_id,store_id,id)=(NEW.tenant_id,NEW.store_id,NEW.table_session_id) FOR UPDATE;
 NEW.before_minimum_minor:=current_minimum;NEW.after_minimum_minor:=current_minimum-NEW.amount_minor;
 RETURN NEW;END $$;
CREATE TRIGGER snapshot_minimum_waiver BEFORE INSERT ON mbox.table_minimum_spend_waivers FOR EACH ROW EXECUTE FUNCTION mbox.snapshot_minimum_waiver();
-- Existing closure and physical-turnover paths now retain order-gate exceptions too.
CREATE OR REPLACE FUNCTION mbox.table_prepayment_unsettled(t uuid,s uuid,session_id uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT EXISTS(SELECT 1 FROM mbox.table_sessions session WHERE(session.tenant_id,session.store_id,session.id)=(t,s,session_id) AND (
  ((session.minimum_spend_mode='prepaid' OR EXISTS(SELECT 1 FROM mbox.order_minimum_spend_releases x WHERE(x.tenant_id,x.store_id,x.table_session_id)=(t,s,session_id)))
   AND mbox.table_qualifying_goods(t,s,session_id)<session.minimum_spend_minor-session.minimum_spend_waiver_minor)
  OR (session.minimum_spend_mode='prepaid' AND EXISTS(SELECT 1 FROM mbox.payments p WHERE(p.tenant_id,p.store_id,p.prepaid_table_session_id)=(t,s,session_id)
   AND(p.status IN('created','pending') OR mbox.prepayment_available(t,s,p.id)>0 OR EXISTS(SELECT 1 FROM mbox.refunds r WHERE(r.tenant_id,r.store_id,r.payment_id)=(t,s,p.id) AND r.status NOT IN('succeeded','cancelled','rejected')))))))
$$;
DO $$ DECLARE definition text;target regprocedure;needle text:='minimum_spend_mode=''prepaid'') ON CONFLICT';BEGIN
 FOREACH target IN ARRAY ARRAY['mbox.close_table_after_customer_left(uuid,uuid,date,text,text,character)'::regprocedure,'mbox.close_table_after_automatic_cutoff(uuid,uuid,date,text,text,character)'::regprocedure] LOOP
 definition:=pg_get_functiondef(target);
 IF position(needle IN definition)=0 THEN RAISE EXCEPTION 'Turnover minimum follow-up target missing';END IF;
 definition:=replace(definition,needle,'(minimum_spend_mode=''prepaid'' OR EXISTS(SELECT 1 FROM mbox.order_minimum_spend_releases x WHERE(x.tenant_id,x.store_id,x.table_session_id)=(tenant_scope,store_scope,p_table_session_id)))) ON CONFLICT');
 EXECUTE definition;
 END LOOP;
END $$;
DO $$ DECLARE owner_name text;BEGIN
 FOR owner_name IN SELECT DISTINCT pg_get_userbyid(proowner) FROM pg_proc WHERE oid IN('mbox.close_table_after_customer_left(uuid,uuid,date,text,text,character)'::regprocedure,'mbox.close_table_after_automatic_cutoff(uuid,uuid,date,text,text,character)'::regprocedure) LOOP
 EXECUTE format('GRANT SELECT ON mbox.order_minimum_spend_releases TO %I',owner_name);
 END LOOP;
END $$;
CREATE FUNCTION mbox.seed_minimum_exception_permissions() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 INSERT INTO mbox.staff_permission_definitions(tenant_id,store_id,code,name,category,description)
 SELECT NEW.tenant_id,NEW.id,p.* FROM(VALUES
 ('order.minimum_spend.release','本单低消放行','commerce','员工账号协助点单自动放行并留痕；付款及整桌低消不变'),
 ('table.minimum_spend.adjust','降低或取消整桌低消','operations','须记录原金额、新金额及原因；不自动退款或收取差额'))p(code,name,category,description) ON CONFLICT DO NOTHING;
 RETURN NEW;END $$;
CREATE TRIGGER stores_seed_minimum_exceptions AFTER INSERT ON mbox.stores FOR EACH ROW EXECUTE FUNCTION mbox.seed_minimum_exception_permissions();
INSERT INTO mbox.staff_permission_definitions(tenant_id,store_id,code,name,category,description)
 SELECT s.tenant_id,s.id,p.* FROM mbox.stores s CROSS JOIN(VALUES
 ('order.minimum_spend.release','本单低消放行','commerce','员工账号协助点单自动放行并留痕；付款及整桌低消不变'),
 ('table.minimum_spend.adjust','降低或取消整桌低消','operations','须记录原金额、新金额及原因；不自动退款或收取差额'))p(code,name,category,description) ON CONFLICT DO NOTHING;
REVOKE ALL ON FUNCTION mbox.guard_order_minimum_release(),mbox.snapshot_minimum_waiver(),mbox.seed_minimum_exception_permissions() FROM PUBLIC;
UPDATE mbox.normalized_schema_metadata SET schema_version='295',updated_at=clock_timestamp() WHERE singleton=true;
COMMIT;
