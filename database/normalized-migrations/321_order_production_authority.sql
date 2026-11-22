BEGIN;

-- A production decision applies to one original order, including allocated receipts.
CREATE FUNCTION mbox.order_production_allowed(t uuid,s uuid,o uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog,mbox AS $$
 SELECT EXISTS (
   SELECT 1 FROM mbox.orders ord
   WHERE (ord.tenant_id,ord.store_id,ord.id)=(t,s,o)
     AND ord.status NOT IN ('draft','cancelled') AND ord.fulfillment_state='active'
     AND CASE
       WHEN ord.total_amount_minor>0 AND ord.channel='staff_assisted'
         AND ord.created_by_employee_id IS NOT NULL AND ord.settlement_mode='table_tab' THEN true
       WHEN mbox.order_consumption_settled(t,s,o) THEN true
       WHEN ord.total_amount_minor=0 THEN
         EXISTS (SELECT 1 FROM mbox.pricing_authorizations a
           WHERE (a.tenant_id,a.store_id,a.order_id)=(t,s,o) AND a.status='consumed'
             AND a.source_type IN ('benefit','employee') AND a.amount_minor=ord.subtotal_amount_minor
             AND a.amount_minor=ord.discount_amount_minor)
         OR (EXISTS (SELECT 1 FROM mbox.order_items i WHERE (i.tenant_id,i.store_id,i.order_id)=(t,s,o)
               AND i.parent_order_item_id IS NULL AND i.status<>'cancelled')
            AND NOT EXISTS (SELECT 1 FROM mbox.order_items i WHERE (i.tenant_id,i.store_id,i.order_id)=(t,s,o)
               AND i.parent_order_item_id IS NULL AND i.status<>'cancelled' AND
               (i.pricing_kind<>'points_redemption' OR NOT EXISTS (
                 SELECT 1 FROM mbox.loyalty_redemption_order_items link JOIN mbox.member_redemptions r
                   ON (r.tenant_id,r.store_id,r.id)=(link.tenant_id,link.store_id,link.redemption_id)
                 WHERE (link.tenant_id,link.store_id,link.order_id,link.order_item_id)=(t,s,o,i.id)
                   AND r.status IN ('authorizing','awaiting_fulfillment','fulfilled')))))
       ELSE false END)
$$;

CREATE INDEX print_jobs_production_ticket_idx ON mbox.print_jobs(tenant_id,store_id,(print_snapshot->>'ticketReference'))
 WHERE print_snapshot->>'kind' IN ('bar_production','kitchen_production');

CREATE FUNCTION mbox.guard_order_production_task() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target uuid;
BEGIN
 SELECT order_id INTO STRICT target FROM mbox.order_items
 WHERE (tenant_id,store_id,id)=(NEW.tenant_id,NEW.store_id,NEW.order_item_id);
 IF NOT mbox.order_production_allowed(NEW.tenant_id,NEW.store_id,target) THEN
   RAISE EXCEPTION '本单尚无制作凭据，请核对原单实收或员工挂桌账记录' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;

CREATE TRIGGER order_production_authority BEFORE INSERT OR UPDATE OF status ON mbox.kds_tasks
 FOR EACH ROW WHEN (NEW.order_item_id IS NOT NULL AND NEW.status IN ('pending','accepted','preparing','ready'))
 EXECUTE FUNCTION mbox.guard_order_production_task();

REVOKE ALL ON FUNCTION mbox.order_production_allowed(uuid,uuid,uuid),mbox.guard_order_production_task() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mbox.order_production_allowed(uuid,uuid,uuid) TO mbox_runtime;
UPDATE mbox.normalized_schema_metadata SET schema_version='321',updated_at=clock_timestamp() WHERE singleton;
COMMIT;
