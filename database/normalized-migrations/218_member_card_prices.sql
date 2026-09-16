BEGIN;
CREATE FUNCTION mbox.customer_card_price(p_tenant uuid,p_store uuid,p_product uuid,p_customer uuid) RETURNS bigint LANGUAGE sql STABLE AS $$
 SELECT min(mi.exclusive_price_minor)
 FROM mbox.member_card_menu_items mi JOIN mbox.member_cards c ON c.tenant_id=mi.tenant_id AND c.store_id=mi.store_id AND c.project_id=mi.project_id
 JOIN mbox.member_card_projects p ON p.tenant_id=c.tenant_id AND p.store_id=c.store_id AND p.id=c.project_id
 WHERE p_customer IS NOT NULL AND mi.tenant_id=p_tenant AND mi.store_id=p_store AND mi.product_id=p_product AND mi.active
  AND c.status='active' AND c.valid_from<=clock_timestamp() AND c.valid_until>clock_timestamp() AND p.status='open'
  AND mbox.canonical_customer_id(c.tenant_id,c.store_id,c.customer_id)=mbox.canonical_customer_id(p_tenant,p_store,p_customer)
  AND mbox.card_social_conditions_met(c.tenant_id,c.store_id,c.project_id,c.customer_id)
$$;
REVOKE ALL ON FUNCTION mbox.customer_card_price(uuid,uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mbox.customer_card_price(uuid,uuid,uuid,uuid) TO mbox_runtime;
UPDATE mbox.normalized_schema_metadata SET schema_version='218',updated_at=clock_timestamp() WHERE singleton=true;
COMMIT;
