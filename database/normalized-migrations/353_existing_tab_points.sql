BEGIN;
CREATE TABLE mbox.tab_points_requests(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL,store_id uuid NOT NULL,order_id uuid NOT NULL,
 customer_id uuid NOT NULL,employee_id uuid NOT NULL,points integer NOT NULL CHECK(points>0),
 due_minor bigint NOT NULL,lines jsonb NOT NULL,order_fingerprint text NOT NULL,request_key text NOT NULL,
 location_version bigint NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),confirmed_at timestamptz,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN('pending','applied','superseded')),
 UNIQUE(tenant_id,store_id,id),UNIQUE(tenant_id,store_id,employee_id,request_key),
 FOREIGN KEY(tenant_id,store_id,order_id) REFERENCES mbox.orders(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,store_id,customer_id) REFERENCES mbox.customers(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,store_id,employee_id) REFERENCES mbox.employees(tenant_id,store_id,id)
);
CREATE UNIQUE INDEX one_active_tab_points ON mbox.tab_points_requests(tenant_id,store_id,order_id) WHERE state IN('pending','applied');
ALTER TABLE mbox.tab_points_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE mbox.tab_points_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY scoped ON mbox.tab_points_requests USING(tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id())
 WITH CHECK(tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id());
GRANT SELECT,INSERT,UPDATE(state,confirmed_at) ON mbox.tab_points_requests TO mbox_runtime;
ALTER TABLE mbox.checkout_coupon_quotes ADD COLUMN tab_request_id uuid,
 ADD FOREIGN KEY(tenant_id,store_id,tab_request_id) REFERENCES mbox.tab_points_requests(tenant_id,store_id,id),
 ALTER COLUMN cart_id DROP NOT NULL,
 ADD CHECK((cart_id IS NULL)=(tab_request_id IS NOT NULL)),ADD UNIQUE(tenant_id,store_id,tab_request_id);
-- Keep the original cart foreign key for all cart lines, including existing records. Tab lines reference the original order item.
ALTER TABLE mbox.checkout_coupon_quote_lines
 DROP CONSTRAINT checkout_coupon_quote_lines_tenant_id_store_id_portion_id_fkey,
 ADD COLUMN tab_item_id uuid,
 ADD COLUMN cart_portion_id uuid GENERATED ALWAYS AS (CASE WHEN tab_item_id IS NULL THEN portion_id END) STORED,
 ADD CHECK(tab_item_id IS NULL OR tab_item_id=portion_id),
 ADD FOREIGN KEY(tenant_id,store_id,cart_portion_id) REFERENCES mbox.guest_shared_cart_portions(tenant_id,store_id,id),
 ADD FOREIGN KEY(tenant_id,store_id,tab_item_id) REFERENCES mbox.order_items(tenant_id,store_id,id);
DO $$ DECLARE d text; BEGIN
 d:=pg_get_functiondef('mbox.validate_checkout_coupon_quote()'::regprocedure);
 EXECUTE replace(d,'IF NOT EXISTS','IF NEW.tab_request_id IS NOT NULL THEN
   IF NOT EXISTS(SELECT 1 FROM mbox.tab_points_requests r JOIN mbox.orders o ON o.id=r.order_id WHERE r.id=NEW.tab_request_id
     AND (r.tenant_id,r.store_id,r.customer_id,r.points)=(NEW.tenant_id,NEW.store_id,NEW.customer_id,NEW.points_used)
     AND r.due_minor=NEW.subtotal_minor AND r.state=''pending'' AND o.table_session_id=NEW.table_session_id AND o.settlement_mode=''table_tab'') THEN
     RAISE EXCEPTION ''挂桌积分报价没有对应原单''; END IF; RETURN NEW; END IF;
   IF NOT EXISTS');
 d:=pg_get_functiondef('mbox.validate_checkout_coupon_quote_line()'::regprocedure);
 EXECUTE replace(d,'IF NOT EXISTS','IF NEW.tab_item_id IS NOT NULL THEN
   IF NOT EXISTS(SELECT 1 FROM mbox.checkout_coupon_quotes q JOIN mbox.tab_points_requests r ON r.id=q.tab_request_id JOIN mbox.order_items i ON i.order_id=r.order_id
     WHERE q.id=NEW.quote_id AND i.id=NEW.tab_item_id AND i.product_id=NEW.product_id AND i.parent_order_item_id IS NULL AND NEW.benefit_id IS NULL) THEN
       RAISE EXCEPTION ''挂桌积分不对应原菜品''; END IF; RETURN NEW; END IF;
   IF NOT EXISTS');
 d:=pg_get_functiondef('mbox.validate_checkout_coupon_order_link()'::regprocedure);
 EXECUTE replace(d,'BEGIN','BEGIN
  IF EXISTS(SELECT 1 FROM mbox.checkout_coupon_quotes q JOIN mbox.tab_points_requests r ON r.id=q.tab_request_id
    JOIN mbox.checkout_point_holds h ON h.quote_id=q.id WHERE q.id=NEW.quote_id AND r.order_id=NEW.order_id
    AND r.state=''applied'' AND h.status=''held'' AND h.points=r.points AND h.customer_id=r.customer_id) THEN RETURN NEW; END IF;');
END $$;
CREATE FUNCTION mbox.tab_points_discount(t uuid,s uuid,o uuid) RETURNS bigint LANGUAGE sql STABLE AS $$
 SELECT coalesce((SELECT points::bigint*100 FROM mbox.tab_points_requests WHERE tenant_id=t AND store_id=s AND order_id=o AND state='applied'),0)
$$;
CREATE FUNCTION mbox.tab_item_discount(t uuid,s uuid,i uuid) RETURNS bigint LANGUAGE sql STABLE AS $$
 SELECT coalesce((SELECT l.discount_minor FROM mbox.checkout_coupon_quote_lines l JOIN mbox.checkout_coupon_order_links k USING(tenant_id,store_id,quote_id)
  WHERE l.tenant_id=t AND l.store_id=s AND l.tab_item_id=i),0)
$$;
CREATE INDEX tab_item_discount_lookup ON mbox.checkout_coupon_quote_lines(tenant_id,store_id,tab_item_id) WHERE tab_item_id IS NOT NULL;
DO $$ DECLARE d text; BEGIN
 d:=pg_get_functiondef('mbox.order_receivable_amount(uuid,uuid,uuid)'::regprocedure);
 EXECUTE replace(d,'original.total_amount_minor+','original.total_amount_minor-mbox.tab_points_discount(p_tenant,p_store,p_order)+');
 -- Only subtract discounts applied AFTER that specific carryover snapshot.
 d:=pg_get_functiondef('mbox.order_collection_due_amount_for_mode(uuid,uuid,uuid,boolean)'::regprocedure);
 EXECUTE replace(d,'GREATEST(0,debt.receivable_minor','GREATEST(0,debt.receivable_minor-coalesce((SELECT points::bigint*100 FROM mbox.tab_points_requests x WHERE x.order_id=p_order AND x.state=''applied'' AND x.confirmed_at>=debt.closed_at),0)');
 d:=pg_get_functiondef('mbox.order_financial_receivable_amount(uuid,uuid,uuid)'::regprocedure);
 EXECUTE replace(d,'SELECT receivable_minor FROM','SELECT receivable_minor-coalesce((SELECT points::bigint*100 FROM mbox.tab_points_requests x WHERE x.order_id=p_order AND x.state=''applied'' AND x.confirmed_at>=order_carryover_debts.closed_at),0) FROM');
 d:=pg_get_functiondef('mbox.order_fully_settled_by_points(uuid,uuid,uuid)'::regprocedure);
 EXECUTE replace(d,'o.total_amount_minor=0','(o.total_amount_minor=0 OR (q.tab_request_id IS NOT NULL AND mbox.order_collection_due_amount(p_tenant,p_store,p_order)=0))');
 d:=pg_get_functiondef('mbox.order_fully_settled_by_checkout_quote(uuid,uuid,uuid)'::regprocedure);
 EXECUTE replace(d,'ordering.total_amount_minor=0','(ordering.total_amount_minor=0 OR (quote.tab_request_id IS NOT NULL AND mbox.order_fully_settled_by_points(t,s,o)))');
 d:=pg_get_viewdef('mbox.loyalty_order_item_basis'::regclass);
 EXECUTE 'CREATE OR REPLACE VIEW mbox.loyalty_order_item_basis WITH (security_invoker=true) AS '||replace(d,'(total_amount_minor)::numeric','(total_amount_minor-mbox.tab_item_discount(item.tenant_id,item.store_id,item.id))::numeric');
 d:=pg_get_functiondef('mbox.ticket_returned_item_discounts(uuid,uuid,uuid)'::regprocedure);
 EXECUTE replace(d,'FROM mbox.order_items i WHERE i.tenant_id=t AND i.store_id=s AND i.order_id=o','FROM (SELECT i.id,i.tenant_id,i.store_id,i.order_id,i.parent_order_item_id,i.quantity,i.discount_amount_minor+mbox.tab_item_discount(t,s,i.id) discount_amount_minor,i.total_amount_minor-mbox.tab_item_discount(t,s,i.id) total_amount_minor FROM mbox.order_items i WHERE i.tenant_id=t AND i.store_id=s AND i.order_id=o) i WHERE i.tenant_id=t AND i.store_id=s AND i.order_id=o');
END $$;
UPDATE mbox.normalized_schema_metadata SET schema_version='353',updated_at=clock_timestamp() WHERE singleton;
COMMIT;
