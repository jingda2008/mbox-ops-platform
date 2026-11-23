BEGIN;
CREATE INDEX ticket_dining_collections_order_lookup ON mbox.ticket_dining_collections(tenant_id,store_id,order_id) WHERE consented_at IS NOT NULL;
-- Preserve the item limits of this particular payment even after later menu and ticket edits.
CREATE FUNCTION mbox.ticket_dining_item_caps(t uuid,s uuid,bill uuid) RETURNS jsonb LANGUAGE sql STABLE AS $$
 SELECT jsonb_object_agg(item_id,amount_minor) FROM (
   SELECT m.order_item_id item_id,sum((line->>'usedMinor')::bigint) amount_minor
   FROM mbox.ticket_dining_collections c
   CROSS JOIN LATERAL jsonb_array_elements(c.line_snapshot) line
   JOIN mbox.checkout_coupon_order_links q ON (q.tenant_id,q.store_id,q.order_id)=(c.tenant_id,c.store_id,c.order_id)
   JOIN mbox.checkout_portion_order_items m ON (m.tenant_id,m.store_id,m.quote_id,m.portion_id)=(q.tenant_id,q.store_id,q.quote_id,(line->>'portionId')::uuid)
   WHERE (c.tenant_id,c.store_id,c.id)=(t,s,bill) GROUP BY m.order_item_id
 ) portions
$$;
CREATE FUNCTION mbox.snapshot_ticket_dining_payment() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE collection uuid; caps jsonb;
BEGIN
 SELECT c.id INTO collection FROM mbox.ticket_dining_collections c JOIN mbox.table_ticket_refund_requests f
 ON (f.tenant_id,f.store_id,f.id)=(c.tenant_id,c.store_id,c.case_id)
 LEFT JOIN mbox.payments previous ON (previous.tenant_id,previous.store_id,previous.id)=(c.tenant_id,c.store_id,c.payment_id)
 WHERE (c.tenant_id,c.store_id,c.order_id)=(NEW.tenant_id,NEW.store_id,NEW.order_id) AND c.consented_at IS NOT NULL
 AND f.status='review' AND (c.payment_id IS NULL OR previous.status IN('closed','failed')) FOR UPDATE OF c;
 IF collection IS NOT NULL THEN
   caps:=mbox.ticket_dining_item_caps(NEW.tenant_id,NEW.store_id,collection);
   IF caps IS NULL OR (SELECT sum(value::bigint) FROM jsonb_each_text(caps))<>NEW.amount_minor THEN
     RAISE EXCEPTION '原补收菜品与应收金额不符'; END IF;
   NEW.provider_snapshot:=coalesce(NEW.provider_snapshot,'{}'::jsonb)||jsonb_build_object('ticketDiningCollection',collection,'ticketDiningItemCaps',caps);
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER snapshot_ticket_dining_payment BEFORE INSERT ON mbox.payments FOR EACH ROW WHEN(NEW.payable_kind='order')
 EXECUTE FUNCTION mbox.snapshot_ticket_dining_payment();
UPDATE mbox.payments p SET provider_snapshot=coalesce(p.provider_snapshot,'{}'::jsonb)||jsonb_build_object('ticketDiningCollection',c.id,'ticketDiningItemCaps',mbox.ticket_dining_item_caps(c.tenant_id,c.store_id,c.id))
 FROM mbox.ticket_dining_collections c WHERE (c.tenant_id,c.store_id,c.payment_id)=(p.tenant_id,p.store_id,p.id);
-- Returning the later dish supplement does not return the original points tender a second time.
DO $$ DECLARE d text; needle text:='AND r.purpose IS DISTINCT FROM ''service_compensation'''; BEGIN
 d:=pg_get_functiondef('mbox.ticket_returned_item_discounts(uuid,uuid,uuid)'::regprocedure);
 IF position(needle in d)=0 THEN RAISE EXCEPTION 'Missing ordinary item refund source'; END IF;
 EXECUTE replace(d,needle,needle||' AND NOT EXISTS (SELECT 1 FROM mbox.ticket_dining_collections supplement WHERE (supplement.tenant_id,supplement.store_id,supplement.payment_id)=(r.tenant_id,r.store_id,r.payment_id))');
END $$;
UPDATE mbox.normalized_schema_metadata SET schema_version='349',updated_at=clock_timestamp() WHERE singleton;
COMMIT;
