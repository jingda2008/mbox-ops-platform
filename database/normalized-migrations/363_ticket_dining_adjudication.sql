BEGIN;

-- NULL distinguishes earlier, full-price proposals from an explicit staff determination.
ALTER TABLE mbox.ticket_dining_collections ADD COLUMN merchant_minor bigint CHECK(merchant_minor>=0),
  DROP CONSTRAINT ticket_dining_collections_amount_minor_check,
  ADD CHECK(amount_minor>0 OR (amount_minor=0 AND merchant_minor IS NOT NULL AND merchant_minor>0 AND payment_id IS NULL));
CREATE FUNCTION mbox.ticket_dining_split_valid(lines jsonb,customer bigint,merchant bigint)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT count(*)>0 AND sum(due)=customer AND sum(used-due)=merchant
    AND bool_and(due IS NOT NULL AND used IS NOT NULL AND due BETWEEN 0 AND used)
  FROM (SELECT (line->>'customerMinor')::bigint due,(line->>'usedMinor')::bigint used
    FROM jsonb_array_elements(lines) line) x
$$;
ALTER TABLE mbox.ticket_dining_collections ADD CHECK(merchant_minor IS NULL OR
  mbox.ticket_dining_split_valid(line_snapshot,amount_minor,merchant_minor) IS TRUE);

CREATE OR REPLACE FUNCTION mbox.ticket_dining_item_caps(t uuid,s uuid,bill uuid) RETURNS jsonb LANGUAGE sql STABLE AS $$
 SELECT jsonb_object_agg(item_id,amount_minor) FROM (
   SELECT m.order_item_id item_id,sum(coalesce(line->>'customerMinor',line->>'usedMinor')::bigint) amount_minor
   FROM mbox.ticket_dining_collections c
   CROSS JOIN LATERAL jsonb_array_elements(c.line_snapshot) line
   JOIN mbox.checkout_coupon_order_links q ON (q.tenant_id,q.store_id,q.order_id)=(c.tenant_id,c.store_id,c.order_id)
   JOIN mbox.checkout_portion_order_items m ON (m.tenant_id,m.store_id,m.quote_id,m.portion_id)=(q.tenant_id,q.store_id,q.quote_id,(line->>'portionId')::uuid)
   WHERE (c.tenant_id,c.store_id,c.id)=(t,s,bill) GROUP BY m.order_item_id
 ) portions
$$;

CREATE OR REPLACE FUNCTION mbox.snapshot_ticket_dining_payment() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE collection uuid; caps jsonb;
BEGIN
 SELECT c.id INTO collection FROM mbox.ticket_dining_collections c JOIN mbox.table_ticket_refund_requests f
 ON (f.tenant_id,f.store_id,f.id)=(c.tenant_id,c.store_id,c.case_id)
 LEFT JOIN mbox.payments previous ON (previous.tenant_id,previous.store_id,previous.id)=(c.tenant_id,c.store_id,c.payment_id)
 WHERE (c.tenant_id,c.store_id,c.order_id)=(NEW.tenant_id,NEW.store_id,NEW.order_id) AND c.amount_minor>0 AND c.consented_at IS NOT NULL
 AND f.status='review' AND (c.payment_id IS NULL OR previous.status IN('closed','failed')) FOR UPDATE OF c;
 IF collection IS NOT NULL THEN
   caps:=mbox.ticket_dining_item_caps(NEW.tenant_id,NEW.store_id,collection);
   IF caps IS NULL OR (SELECT sum(value::bigint) FROM jsonb_each_text(caps))<>NEW.amount_minor THEN
     RAISE EXCEPTION '原补收菜品与应收金额不符'; END IF;
   NEW.provider_snapshot:=coalesce(NEW.provider_snapshot,'{}'::jsonb)||jsonb_build_object('ticketDiningCollection',collection,'ticketDiningItemCaps',caps);
 END IF;
 RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION mbox.link_ticket_dining_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE collection record;
BEGIN
 SELECT c.id,c.amount_minor,c.payment_id,p.status INTO collection FROM mbox.ticket_dining_collections c
 JOIN mbox.table_ticket_refund_requests f ON (f.tenant_id,f.store_id,f.id)=(c.tenant_id,c.store_id,c.case_id)
 LEFT JOIN mbox.payments p ON (p.tenant_id,p.store_id,p.id)=(c.tenant_id,c.store_id,c.payment_id)
 WHERE (c.tenant_id,c.store_id,c.order_id)=(NEW.tenant_id,NEW.store_id,NEW.order_id)
 AND c.amount_minor>0 AND c.consented_at IS NOT NULL AND f.status='review' AND (p.id IS NULL OR p.status NOT IN('succeeded','partially_refunded','refunded'))
 ORDER BY c.created_at LIMIT 1 FOR UPDATE OF c;
 IF FOUND THEN
   IF TG_TABLE_NAME='order_payment_allocations' THEN RAISE EXCEPTION '请在原菜品订单单独收取已确认补款'; END IF;
   IF NEW.amount_minor<>collection.amount_minor OR (collection.payment_id IS NOT NULL AND collection.status NOT IN('failed','closed'))
     THEN RAISE EXCEPTION '补款金额或原收款状态已变化，请核对原单'; END IF;
   UPDATE mbox.ticket_dining_collections SET payment_id=NEW.id WHERE id=collection.id;
 END IF;
 RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION mbox.ticket_pending_dining(t uuid,s uuid,o uuid)
RETURNS TABLE(id uuid,case_id uuid,amount_minor bigint) LANGUAGE sql STABLE AS $$
 SELECT c.id,c.case_id,c.amount_minor FROM mbox.ticket_dining_collections c
 JOIN mbox.table_ticket_refund_requests f ON(f.tenant_id,f.store_id,f.id)=(t,s,c.case_id)
 LEFT JOIN mbox.payments p ON(p.tenant_id,p.store_id,p.id)=(t,s,c.payment_id)
 WHERE (c.tenant_id,c.store_id,c.order_id)=(t,s,o) AND c.amount_minor>0 AND c.consented_at IS NOT NULL
 AND f.status='review' AND f.close_intent IS NULL AND
 (c.payment_id IS NULL OR p.status IN('failed','closed','created','pending'))
$$;

UPDATE mbox.normalized_schema_metadata SET schema_version='363',updated_at=clock_timestamp() WHERE singleton;
COMMIT;
