BEGIN;
ALTER TABLE mbox.products ADD COLUMN visible_from timestamptz,ADD COLUMN visible_until timestamptz,
  ADD CHECK(visible_until IS NULL OR visible_from IS NULL OR visible_until>visible_from);
CREATE OR REPLACE FUNCTION mbox.product_visible_now(p_tenant uuid,p_store uuid,p_product uuid,p_customer uuid,p_at timestamptz DEFAULT clock_timestamp())
RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT COALESCE((SELECT (p.visible_from IS NULL OR p.visible_from<=p_at) AND (p.visible_until IS NULL OR p.visible_until>p_at)
   AND mbox.menu_category_visible_at(p_tenant,p_store,p.category_code,p_at) AND ((p.guest_visible AND mbox.service_window_deadline(p_tenant,p_store,p_product,NULL,true,p_at) IS NOT NULL)
 OR mbox.customer_has_card_menu_item(p_tenant,p_store,p_product,p_customer))
 FROM mbox.products p WHERE p.tenant_id=p_tenant AND p.store_id=p_store AND p.id=p_product),false)
$$;

UPDATE mbox.normalized_schema_metadata SET schema_version='347',updated_at=clock_timestamp() WHERE singleton;
COMMIT;
