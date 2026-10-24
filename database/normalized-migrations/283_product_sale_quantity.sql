BEGIN;
-- NULL deliberately preserves the existing inventory/availability workflow.
ALTER TABLE mbox.products
  ADD COLUMN sale_remaining_quantity integer CHECK(sale_remaining_quantity>=0),
  ADD COLUMN sale_quantity_version bigint NOT NULL DEFAULT 0,
  ADD COLUMN sale_quantity_generation bigint NOT NULL DEFAULT 0;
CREATE TABLE mbox.product_sale_quantity_allocations (
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  order_item_id uuid NOT NULL,
  order_id uuid NOT NULL,
  product_id uuid NOT NULL,
  generation bigint NOT NULL,
  quantity integer NOT NULL CHECK(quantity>0),
  status text NOT NULL CHECK(status IN ('reserved','consumed','released')),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(tenant_id,store_id,order_item_id),
  FOREIGN KEY(tenant_id,store_id,order_item_id) REFERENCES mbox.order_items(tenant_id,store_id,id),
  FOREIGN KEY(tenant_id,store_id,order_id) REFERENCES mbox.orders(tenant_id,store_id,id),
  FOREIGN KEY(tenant_id,store_id,product_id) REFERENCES mbox.products(tenant_id,store_id,id)
);
CREATE INDEX product_sale_quantity_order_idx ON mbox.product_sale_quantity_allocations(tenant_id,store_id,order_id);
ALTER TABLE mbox.product_sale_quantity_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE mbox.product_sale_quantity_allocations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_store_isolation ON mbox.product_sale_quantity_allocations
 USING(tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id())
 WITH CHECK(tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id());
GRANT SELECT,INSERT,UPDATE ON mbox.product_sale_quantity_allocations TO mbox_runtime;
-- Includes fixed bundle contents. Choice options are checked separately and
-- all actual selected lines are checked again atomically at order submission.
CREATE FUNCTION mbox.product_sale_quantity_available(p_tenant uuid,p_store uuid,p_product uuid,p_quantity integer DEFAULT 1)
RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog,mbox AS $$
 SELECT COALESCE(bool_and(p.sale_remaining_quantity IS NULL OR p.sale_remaining_quantity>=d.quantity),true)
 FROM (SELECT p_product AS id,p_quantity AS quantity
   UNION ALL SELECT component_product_id,quantity*p_quantity FROM mbox.product_bundle_components
   WHERE tenant_id=p_tenant AND store_id=p_store AND bundle_product_id=p_product) d
 JOIN mbox.products p ON p.tenant_id=p_tenant AND p.store_id=p_store AND p.id=d.id
$$;
REVOKE ALL ON FUNCTION mbox.product_sale_quantity_available(uuid,uuid,uuid,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mbox.product_sale_quantity_available(uuid,uuid,uuid,integer) TO mbox_runtime;
UPDATE mbox.normalized_schema_metadata SET schema_version='283',updated_at=clock_timestamp() WHERE singleton=true;
COMMIT;
