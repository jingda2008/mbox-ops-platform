BEGIN;
ALTER TABLE mbox.loyalty_point_lots ADD COLUMN ticket_ordinal integer CHECK(ticket_ordinal>0);
CREATE TABLE mbox.checkout_portion_order_items(
 tenant_id uuid NOT NULL,store_id uuid NOT NULL,quote_id uuid NOT NULL,portion_id uuid NOT NULL,order_item_id uuid NOT NULL,
 PRIMARY KEY(tenant_id,store_id,quote_id,portion_id),UNIQUE(tenant_id,store_id,order_item_id),
 FOREIGN KEY(tenant_id,store_id,quote_id,portion_id) REFERENCES mbox.checkout_coupon_quote_lines(tenant_id,store_id,quote_id,portion_id),
 FOREIGN KEY(tenant_id,store_id,order_item_id) REFERENCES mbox.order_items(tenant_id,store_id,id)
);
ALTER TABLE mbox.checkout_portion_order_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE mbox.checkout_portion_order_items FORCE ROW LEVEL SECURITY;
CREATE POLICY scoped ON mbox.checkout_portion_order_items USING(tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id())
 WITH CHECK(tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id());
GRANT SELECT,INSERT ON mbox.checkout_portion_order_items TO mbox_runtime;
CREATE FUNCTION mbox.ticket_returned_item_discounts(t uuid,s uuid,o uuid) RETURNS TABLE(item_id uuid,returned_minor bigint)
LANGUAGE sql STABLE AS $$
WITH returned_units AS (
      SELECT u.* FROM mbox.order_item_quantity_units u JOIN mbox.item_after_sales_cases c ON (c.tenant_id,c.store_id,c.id)=(u.tenant_id,u.store_id,u.stopped_by_case_id)
      WHERE u.tenant_id=$1 AND u.store_id=$2 AND c.order_id=o AND u.operationally_stopped
        AND c.status IN('approved','completed') AND c.decided_by_employee_id IS NOT NULL AND c.decided_by_employee_id<>c.requested_by_employee_id
        AND (c.amount_minor=0 OR c.amount_minor=(SELECT COALESCE(sum(r.amount_minor),0) FROM mbox.item_after_sales_case_refunds link JOIN mbox.refunds r ON (r.tenant_id,r.store_id,r.id)=(link.tenant_id,link.store_id,link.refund_id) WHERE (link.tenant_id,link.store_id,link.case_id)=(c.tenant_id,c.store_id,c.id) AND r.status='succeeded'))
    ) SELECT i.id,least(i.discount_amount_minor,floor(CASE
      WHEN EXISTS(SELECT 1 FROM mbox.order_items child WHERE (child.tenant_id,child.store_id,child.parent_order_item_id)=(i.tenant_id,i.store_id,i.id)) THEN
        CASE WHEN EXISTS(SELECT 1 FROM returned_units u JOIN mbox.order_items child ON child.id=u.order_item_id AND child.tenant_id=u.tenant_id AND child.store_id=u.store_id WHERE child.parent_order_item_id=i.id)
          AND NOT EXISTS(SELECT 1 FROM mbox.order_items child WHERE (child.tenant_id,child.store_id,child.parent_order_item_id)=(i.tenant_id,i.store_id,i.id) AND child.quantity>(SELECT count(*) FROM returned_units u WHERE u.order_item_id=child.id) AND COALESCE(child.product_snapshot->>'singlePriceReferenceMinor','')!~'^[0-9]{1,15}$') THEN
          GREATEST(0,i.discount_amount_minor-COALESCE((SELECT sum(CASE WHEN child.quantity=(SELECT count(*) FROM returned_units u WHERE u.order_item_id=child.id) THEN 0 ELSE (child.quantity-(SELECT count(*) FROM returned_units u WHERE u.order_item_id=child.id))*(child.product_snapshot->>'singlePriceReferenceMinor')::bigint END) FROM mbox.order_items child WHERE (child.tenant_id,child.store_id,child.parent_order_item_id)=(i.tenant_id,i.store_id,i.id)),0)) ELSE 0 END
      WHEN i.total_amount_minor>0 THEN
        i.discount_amount_minor::numeric*LEAST(i.total_amount_minor,COALESCE((SELECT sum(ri.amount_minor) FROM mbox.refund_items ri JOIN mbox.refunds r ON (r.tenant_id,r.store_id,r.id)=(ri.tenant_id,ri.store_id,ri.refund_id) WHERE ri.tenant_id=i.tenant_id AND ri.store_id=i.store_id AND ri.order_item_id=i.id AND r.status='succeeded' AND r.purpose IS DISTINCT FROM 'service_compensation'),0))/i.total_amount_minor
      ELSE i.discount_amount_minor::numeric*(SELECT count(*) FROM returned_units u WHERE u.order_item_id=i.id)/i.quantity
      END))::bigint FROM mbox.order_items i WHERE i.tenant_id=t AND i.store_id=s AND i.order_id=o AND i.parent_order_item_id IS NULL
$$;
CREATE FUNCTION mbox.checkout_returned_sources(t uuid,s uuid,q uuid) RETURNS TABLE(portion_id uuid,lot_id uuid,returned_minor bigint)
LANGUAGE sql STABLE AS $$
 WITH original AS(
  SELECT src.portion_id,src.lot_id,src.amount_minor,line.discount_minor,ret.returned_minor,
    floor(src.amount_minor::numeric*ret.returned_minor/line.discount_minor)::bigint base,
    mod(src.amount_minor::numeric*ret.returned_minor,line.discount_minor) remainder
  FROM mbox.checkout_coupon_order_links link JOIN mbox.checkout_point_portion_sources src USING(tenant_id,store_id,quote_id)
  JOIN mbox.checkout_coupon_quote_lines line USING(tenant_id,store_id,quote_id,portion_id)
  JOIN mbox.checkout_portion_order_items item USING(tenant_id,store_id,quote_id,portion_id)
  JOIN mbox.ticket_returned_item_discounts(t,s,link.order_id) ret ON ret.item_id=item.order_item_id
  WHERE src.tenant_id=t AND src.store_id=s AND src.quote_id=q
 ), ranked AS(SELECT original.*,sum(base) OVER(PARTITION BY portion_id) allocated,
   row_number() OVER(PARTITION BY portion_id ORDER BY remainder DESC,lot_id) tie FROM original)
 SELECT ranked.portion_id,ranked.lot_id,base+CASE WHEN tie<=ranked.returned_minor-allocated THEN 1 ELSE 0 END FROM ranked
$$;
UPDATE mbox.normalized_schema_metadata SET schema_version='340',updated_at=clock_timestamp() WHERE singleton;
COMMIT;
