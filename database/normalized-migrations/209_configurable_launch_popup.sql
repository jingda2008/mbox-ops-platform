BEGIN;
CREATE TABLE mbox.launch_popup_policies(
 tenant_id uuid NOT NULL,store_id uuid NOT NULL,enabled boolean NOT NULL DEFAULT false,
 title text NOT NULL DEFAULT '今日推荐' CHECK(length(title) BETWEEN 1 AND 80),
 content text NOT NULL DEFAULT '' CHECK(length(content)<=1000),
 frequency text NOT NULL DEFAULT 'daily' CHECK(frequency IN('daily','session','always')),
 version integer NOT NULL DEFAULT 1,updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,store_id),FOREIGN KEY(tenant_id,store_id) REFERENCES mbox.stores(tenant_id,id)
);
CREATE TABLE mbox.launch_popup_products(
 tenant_id uuid NOT NULL,store_id uuid NOT NULL,product_id uuid NOT NULL,sort_order integer NOT NULL,
 PRIMARY KEY(tenant_id,store_id,product_id),FOREIGN KEY(tenant_id,store_id) REFERENCES mbox.stores(tenant_id,id),
 FOREIGN KEY(tenant_id,store_id,product_id) REFERENCES mbox.products(tenant_id,store_id,id)
);
DO $$ DECLARE n text; BEGIN
 FOREACH n IN ARRAY ARRAY['launch_popup_policies','launch_popup_products'] LOOP
  EXECUTE format('ALTER TABLE mbox.%I ENABLE ROW LEVEL SECURITY',n);
  EXECUTE format('ALTER TABLE mbox.%I FORCE ROW LEVEL SECURITY',n);
  EXECUTE format('CREATE POLICY tenant_store_isolation ON mbox.%I USING(tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id()) WITH CHECK(tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id())',n);
  EXECUTE format('REVOKE ALL ON mbox.%I FROM PUBLIC,mbox_runtime',n);
  EXECUTE format('GRANT SELECT,INSERT,UPDATE ON mbox.%I TO mbox_runtime',n);
 END LOOP;
END $$;
GRANT DELETE ON mbox.launch_popup_products TO mbox_runtime;
UPDATE mbox.normalized_schema_metadata SET schema_version='209',updated_at=clock_timestamp() WHERE singleton=true;
COMMIT;
