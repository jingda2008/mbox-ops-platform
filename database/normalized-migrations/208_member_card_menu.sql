BEGIN;
CREATE TABLE mbox.member_card_menu_items(
 tenant_id uuid NOT NULL,store_id uuid NOT NULL,project_id uuid NOT NULL,product_id uuid NOT NULL,
 exclusive boolean NOT NULL,active boolean NOT NULL DEFAULT true,sort_order integer NOT NULL DEFAULT 0,
 exclusive_price_minor bigint CHECK(exclusive_price_minor>=0),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,store_id,project_id,product_id),
 FOREIGN KEY(tenant_id,store_id,project_id) REFERENCES mbox.member_card_projects(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,store_id,product_id) REFERENCES mbox.products(tenant_id,store_id,id)
);
ALTER TABLE mbox.member_card_menu_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE mbox.member_card_menu_items FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_store_isolation ON mbox.member_card_menu_items USING(tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id()) WITH CHECK(tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id());
REVOKE ALL ON mbox.member_card_menu_items FROM PUBLIC,mbox_runtime;
GRANT SELECT,INSERT,UPDATE ON mbox.member_card_menu_items TO mbox_runtime;
CREATE FUNCTION mbox.customer_has_card_menu_item(p_tenant uuid,p_store uuid,p_product uuid,p_customer uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT p_customer IS NOT NULL AND EXISTS(
  SELECT 1 FROM mbox.member_card_menu_items mi JOIN mbox.member_cards c ON c.tenant_id=mi.tenant_id AND c.store_id=mi.store_id AND c.project_id=mi.project_id
  JOIN mbox.member_card_projects p ON p.tenant_id=c.tenant_id AND p.store_id=c.store_id AND p.id=c.project_id
  WHERE mi.tenant_id=p_tenant AND mi.store_id=p_store AND mi.product_id=p_product AND mi.active AND mi.exclusive
  AND c.status='active' AND c.valid_from<=clock_timestamp() AND c.valid_until>clock_timestamp() AND p.status='open'
  AND mbox.canonical_customer_id(c.tenant_id,c.store_id,c.customer_id)=mbox.canonical_customer_id(p_tenant,p_store,p_customer)
  AND mbox.card_social_conditions_met(c.tenant_id,c.store_id,c.project_id,c.customer_id)
 )
$$;
REVOKE ALL ON FUNCTION mbox.customer_has_card_menu_item(uuid,uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mbox.customer_has_card_menu_item(uuid,uuid,uuid,uuid) TO mbox_runtime;
UPDATE mbox.normalized_schema_metadata SET schema_version='208',updated_at=clock_timestamp() WHERE singleton=true;
COMMIT;
