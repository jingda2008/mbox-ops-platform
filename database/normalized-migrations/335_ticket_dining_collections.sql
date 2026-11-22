BEGIN;
CREATE TABLE mbox.ticket_dining_collections(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL,store_id uuid NOT NULL,case_id uuid NOT NULL,order_id uuid NOT NULL,
  amount_minor bigint NOT NULL CHECK(amount_minor>0),line_snapshot jsonb NOT NULL CHECK(jsonb_typeof(line_snapshot)='array'),
  reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 2 AND 500), proposed_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),consented_at timestamptz,payment_id uuid,
  UNIQUE(tenant_id,store_id,case_id,order_id), UNIQUE(tenant_id,store_id,payment_id),
  FOREIGN KEY(tenant_id,store_id,case_id) REFERENCES mbox.table_ticket_refund_requests(tenant_id,store_id,id),
  FOREIGN KEY(tenant_id,store_id,order_id) REFERENCES mbox.orders(tenant_id,store_id,id),
  FOREIGN KEY(tenant_id,store_id,proposed_by) REFERENCES mbox.employees(tenant_id,store_id,id),
  FOREIGN KEY(tenant_id,store_id,payment_id) REFERENCES mbox.payments(tenant_id,store_id,id)
);
ALTER TABLE mbox.ticket_dining_collections ENABLE ROW LEVEL SECURITY;
ALTER TABLE mbox.ticket_dining_collections FORCE ROW LEVEL SECURITY;
CREATE POLICY scoped ON mbox.ticket_dining_collections USING(tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id())
 WITH CHECK(tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id());
GRANT SELECT,INSERT,UPDATE(consented_at,payment_id) ON mbox.ticket_dining_collections TO mbox_runtime;
CREATE FUNCTION mbox.ticket_dining_due_basis(t uuid,s uuid,o uuid) RETURNS bigint LANGUAGE sql STABLE AS $$
 SELECT coalesce(sum(c.amount_minor),0)::bigint FROM mbox.ticket_dining_collections c
 JOIN mbox.table_ticket_refund_requests f ON (f.tenant_id,f.store_id,f.id)=(c.tenant_id,c.store_id,c.case_id)
 WHERE (c.tenant_id,c.store_id,c.order_id)=(t,s,o) AND c.consented_at IS NOT NULL AND f.status NOT IN('cancelled','rejected')
$$;
CREATE OR REPLACE FUNCTION mbox.order_receivable_amount(p_tenant uuid,p_store uuid,p_order uuid) RETURNS bigint LANGUAGE sql STABLE AS $$
 SELECT original.total_amount_minor+mbox.ticket_dining_due_basis(p_tenant,p_store,p_order)
   -COALESCE((SELECT sum(a.amount_minor) FROM mbox.item_receivable_adjustment_facts a
     WHERE (a.tenant_id,a.store_id,a.order_id)=(original.tenant_id,original.store_id,original.id)),0)::bigint
 FROM mbox.orders original WHERE (original.tenant_id,original.store_id,original.id)=(p_tenant,p_store,p_order)
   AND p_tenant=mbox.current_tenant_id() AND p_store=mbox.current_store_id()
$$;
-- Original order collections remain separately identifiable even when a cashier retries.
CREATE FUNCTION mbox.link_ticket_dining_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE collection record;
BEGIN
 SELECT c.id,c.amount_minor,c.payment_id,p.status INTO collection FROM mbox.ticket_dining_collections c
 JOIN mbox.table_ticket_refund_requests f ON (f.tenant_id,f.store_id,f.id)=(c.tenant_id,c.store_id,c.case_id)
 LEFT JOIN mbox.payments p ON (p.tenant_id,p.store_id,p.id)=(c.tenant_id,c.store_id,c.payment_id)
 WHERE (c.tenant_id,c.store_id,c.order_id)=(NEW.tenant_id,NEW.store_id,NEW.order_id)
 AND c.consented_at IS NOT NULL AND f.status='review' AND (p.id IS NULL OR p.status NOT IN('succeeded','partially_refunded','refunded'))
 ORDER BY c.created_at LIMIT 1 FOR UPDATE OF c;
 IF FOUND THEN
   IF TG_TABLE_NAME='order_payment_allocations' THEN RAISE EXCEPTION '请在原菜品订单单独收取已确认补款'; END IF;
   IF NEW.amount_minor<>collection.amount_minor OR (collection.payment_id IS NOT NULL AND collection.status NOT IN('failed','closed'))
     THEN RAISE EXCEPTION '补款金额或原收款状态已变化，请核对原单'; END IF;
   UPDATE mbox.ticket_dining_collections SET payment_id=NEW.id WHERE id=collection.id;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER link_ticket_dining_receipt AFTER INSERT ON mbox.payments FOR EACH ROW WHEN(NEW.payable_kind='order') EXECUTE FUNCTION mbox.link_ticket_dining_receipt();
CREATE TRIGGER guard_batch_ticket_dining BEFORE INSERT ON mbox.order_payment_allocations FOR EACH ROW EXECUTE FUNCTION mbox.link_ticket_dining_receipt();
UPDATE mbox.normalized_schema_metadata SET schema_version='335',updated_at=clock_timestamp() WHERE singleton;
COMMIT;
