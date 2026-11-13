BEGIN;
CREATE TABLE mbox.channel_store_limits(
 tenant_id uuid NOT NULL,store_id uuid NOT NULL,claim_limit integer NOT NULL CHECK(claim_limit>=0),capacity_limit integer NOT NULL CHECK(capacity_limit>=0),cost_limit_minor bigint NOT NULL CHECK(cost_limit_minor>=0),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(tenant_id,store_id),FOREIGN KEY(tenant_id,store_id) REFERENCES mbox.stores(tenant_id,id)
);
ALTER TABLE mbox.channel_batches ADD COLUMN created_by uuid,ADD COLUMN approved_by uuid,ADD COLUMN approved_at timestamptz,
 ADD FOREIGN KEY(tenant_id,store_id,created_by) REFERENCES mbox.employees(tenant_id,store_id,id),
 ADD FOREIGN KEY(tenant_id,store_id,approved_by) REFERENCES mbox.employees(tenant_id,store_id,id),
 ADD CHECK(approved_by IS NULL OR approved_by<>created_by);
ALTER TABLE mbox.channel_promoters ADD COLUMN contact_employee_id uuid,ADD COLUMN restaurant_scope boolean NOT NULL DEFAULT false,
 ADD FOREIGN KEY(tenant_id,store_id,contact_employee_id) REFERENCES mbox.employees(tenant_id,store_id,id);
ALTER TABLE mbox.channel_gift_promises ADD COLUMN generation integer NOT NULL DEFAULT 1 CHECK(generation>0);
ALTER TABLE mbox.channel_gift_stock ADD COLUMN generation integer NOT NULL DEFAULT 1 CHECK(generation>0);
ALTER TABLE mbox.channel_gift_stock DROP CONSTRAINT channel_gift_stock_pkey;
ALTER TABLE mbox.channel_gift_stock ADD PRIMARY KEY(tenant_id,store_id,claim_id,generation,inventory_item_id);
CREATE TABLE mbox.channel_gift_versions(
 tenant_id uuid NOT NULL,store_id uuid NOT NULL,claim_id uuid NOT NULL,generation integer NOT NULL,snapshot jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(tenant_id,store_id,claim_id,generation),
 FOREIGN KEY(tenant_id,store_id,claim_id) REFERENCES mbox.channel_claims(tenant_id,store_id,id)
);
CREATE TABLE mbox.channel_order_corrections(
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,tenant_id uuid NOT NULL,store_id uuid NOT NULL,order_id uuid NOT NULL,
 visit_id uuid NOT NULL,batch_id uuid NOT NULL,employee_id uuid NOT NULL,reason text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(tenant_id,store_id,order_id) REFERENCES mbox.orders(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,store_id,visit_id) REFERENCES mbox.channel_visits(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,store_id,batch_id) REFERENCES mbox.channel_batches(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,store_id,employee_id) REFERENCES mbox.employees(tenant_id,store_id,id)
);
CREATE VIEW mbox.channel_effective_attributions WITH(security_invoker=true) AS
 SELECT a.tenant_id,a.store_id,a.order_id,COALESCE(c.visit_id,a.visit_id) AS visit_id,COALESCE(c.batch_id,a.batch_id) AS batch_id FROM mbox.channel_order_attributions a
 LEFT JOIN LATERAL(SELECT x.visit_id,x.batch_id FROM mbox.channel_order_corrections x WHERE (x.tenant_id,x.store_id,x.order_id)=(a.tenant_id,a.store_id,a.order_id) ORDER BY x.id DESC LIMIT 1)c ON true
 UNION ALL SELECT x.tenant_id,x.store_id,x.order_id,x.visit_id,x.batch_id FROM mbox.channel_order_corrections x
 WHERE NOT EXISTS(SELECT 1 FROM mbox.channel_order_attributions a WHERE (a.tenant_id,a.store_id,a.order_id)=(x.tenant_id,x.store_id,x.order_id))
 AND NOT EXISTS(SELECT 1 FROM mbox.channel_order_corrections newer WHERE (newer.tenant_id,newer.store_id,newer.order_id)=(x.tenant_id,x.store_id,x.order_id) AND newer.id>x.id);
GRANT SELECT ON mbox.channel_effective_attributions TO mbox_runtime;
DO $$ DECLARE n text; BEGIN
 FOREACH n IN ARRAY ARRAY['channel_store_limits','channel_gift_versions','channel_order_corrections'] LOOP
  EXECUTE format('ALTER TABLE mbox.%I ENABLE ROW LEVEL SECURITY',n);EXECUTE format('ALTER TABLE mbox.%I FORCE ROW LEVEL SECURITY',n);
  EXECUTE format('CREATE POLICY scoped ON mbox.%I USING(tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id()) WITH CHECK(tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id())',n);
  EXECUTE format('GRANT SELECT,INSERT ON mbox.%I TO mbox_runtime',n);
  IF n<>'channel_store_limits' THEN EXECUTE format('CREATE TRIGGER immutable_row BEFORE UPDATE OR DELETE ON mbox.%I FOR EACH ROW EXECUTE FUNCTION mbox.reject_row_change()',n);END IF;
 END LOOP;
END $$;
GRANT UPDATE ON mbox.channel_store_limits TO mbox_runtime;
GRANT USAGE,SELECT ON SEQUENCE mbox.channel_order_corrections_id_seq TO mbox_runtime;
CREATE FUNCTION mbox.guard_channel_gift_promise() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF (NEW.tenant_id,NEW.store_id,NEW.claim_id,NEW.created_at) IS DISTINCT FROM (OLD.tenant_id,OLD.store_id,OLD.claim_id,OLD.created_at) THEN RAISE EXCEPTION 'Gift identity immutable';END IF;
 IF OLD.state='released' AND NEW.state='reserved' AND OLD.order_id IS NULL AND NEW.order_id IS NULL AND NEW.generation=OLD.generation+1 THEN RETURN NEW;END IF;
 IF (to_jsonb(NEW)-ARRAY['state','completed_at','order_id']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','completed_at','order_id'])
 OR NOT ((OLD.state='reserved' AND NEW.state IN('converted','released') AND NEW.order_id IS NULL) OR (OLD.state='converted' AND NEW.state='converted' AND OLD.order_id IS NULL AND NEW.order_id IS NOT NULL)) THEN RAISE EXCEPTION 'Gift promise transition invalid';END IF;
 RETURN NEW;END $$;
CREATE TRIGGER guarded_update BEFORE UPDATE ON mbox.channel_gift_promises FOR EACH ROW EXECUTE FUNCTION mbox.guard_channel_gift_promise();
REVOKE ALL ON FUNCTION mbox.guard_channel_gift_promise() FROM PUBLIC;
UPDATE mbox.normalized_schema_metadata SET schema_version='311',updated_at=clock_timestamp() WHERE singleton=true;
COMMIT;
