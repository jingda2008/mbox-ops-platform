BEGIN;
ALTER TABLE mbox.table_ticket_refund_requests ADD COLUMN close_intent text CHECK(close_intent IN('cancelled','rejected','zero')),
 ADD COLUMN close_reason text,ADD COLUMN close_actor text,ADD COLUMN closed_without_receipt boolean NOT NULL DEFAULT false;
GRANT UPDATE(close_intent,close_reason,close_actor,closed_without_receipt) ON mbox.table_ticket_refund_requests TO mbox_runtime;
ALTER TABLE mbox.ticket_dining_collections ADD COLUMN return_refund_id uuid,
 ADD FOREIGN KEY(tenant_id,store_id,return_refund_id) REFERENCES mbox.refunds(tenant_id,store_id,id);
GRANT UPDATE(return_refund_id) ON mbox.ticket_dining_collections TO mbox_runtime;
CREATE FUNCTION mbox.finish_ticket_case(t uuid,s uuid,case_key uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE item record; lot mbox.loyalty_point_lots%ROWTYPE; balance integer;receipt uuid;completed timestamptz;
BEGIN
 SELECT f.id case_id,k.id ticket_id,k.reservation_lock_id,k.point_lot_id,f.refund_id,f.status,f.close_intent,r.status cash_status,r.completed_at INTO item
 FROM mbox.table_ticket_refund_requests f JOIN mbox.table_tickets k ON(k.tenant_id,k.store_id,k.id)=(f.tenant_id,f.store_id,f.ticket_id)
 LEFT JOIN mbox.refunds r ON(r.tenant_id,r.store_id,r.id)=(f.tenant_id,f.store_id,f.refund_id)
 WHERE f.tenant_id=t AND f.store_id=s AND f.id=case_key FOR UPDATE OF f,k;
 IF NOT FOUND OR item.status IN('cancelled','rejected','refunded') THEN RETURN; END IF;
 IF item.refund_id IS NOT NULL AND item.cash_status NOT IN('succeeded','cancelled','rejected') THEN RETURN; END IF;
 IF item.point_lot_id IS NOT NULL THEN SELECT * INTO STRICT lot FROM mbox.loyalty_point_lots WHERE tenant_id=t AND store_id=s AND id=item.point_lot_id FOR UPDATE; END IF;
 IF item.cash_status='succeeded' OR (item.refund_id IS NULL AND item.close_intent='zero') THEN
   receipt:=item.refund_id; completed:=item.completed_at;
    IF item.point_lot_id IS NOT NULL AND lot.status='ticket_hold' THEN
      IF lot.remaining_points>0 THEN
        UPDATE mbox.loyalty_accounts SET available_points=available_points-lot.remaining_points
          WHERE tenant_id=t AND store_id=s AND membership_id=lot.membership_id RETURNING available_points INTO STRICT balance;
        UPDATE mbox.customer_memberships SET points_balance=balance WHERE tenant_id=t AND store_id=s AND id=lot.membership_id;
        INSERT INTO mbox.loyalty_point_ledger(tenant_id,store_id,membership_id,customer_id,entry_type,points_delta,balance_after,
          source_type,source_id,reason,idempotency_key,refund_id,reversal_of_entry_id)
          VALUES(t,s,lot.membership_id,lot.customer_id,'reverse',-lot.remaining_points,balance,'refund',item.ticket_id,
            '按原票收回赠分','ticket-refund:'||coalesce(receipt,case_key),receipt,lot.source_ledger_entry_id);
        INSERT INTO mbox.loyalty_point_lot_movements(tenant_id,store_id,lot_id,movement_type,points_delta,balance_after,source_type,source_id,idempotency_key)
          VALUES(t,s,lot.id,'reverse',-lot.remaining_points,0,'refund',coalesce(receipt,case_key),'ticket-refund:'||coalesce(receipt,case_key));
      END IF;
      UPDATE mbox.loyalty_point_lots SET remaining_points=0,status='reversed' WHERE id=lot.id;
    END IF;
    UPDATE mbox.table_tickets SET refunded_at=coalesce(completed,clock_timestamp()) WHERE id=item.ticket_id;
    -- Only return a lock created for this ticket. Independent reservations and seated tables retain ownership.
    UPDATE mbox.reservation_table_locks l SET status='cancelled' FROM mbox.reservations r
      WHERE l.id=item.reservation_lock_id AND (l.tenant_id,l.store_id,l.reservation_id)=(r.tenant_id,r.store_id,r.id)
        AND r.reservation_snapshot->>'ticketId'=item.ticket_id::text AND r.status IN('pending','confirmed') AND l.status IN('held','confirmed');
    UPDATE mbox.reservations r SET status='cancelled'
      WHERE r.tenant_id=t AND r.store_id=s AND r.public_id='ticket-'||item.ticket_id::text
        AND r.reservation_snapshot->>'ticketId'=item.ticket_id::text AND r.status IN('pending','confirmed');
    UPDATE mbox.table_ticket_refund_requests SET status='refunded' WHERE id=item.case_id AND tenant_id=t AND store_id=s;

   IF receipt IS NULL THEN UPDATE mbox.table_ticket_refund_requests SET closed_without_receipt=true WHERE tenant_id=t AND store_id=s AND id=case_key; END IF;
 ELSIF coalesce(item.close_intent,item.cash_status) IN('cancelled','rejected') THEN
   -- A verified supplement may only be undone by an actual return of that receipt.
   IF EXISTS(SELECT 1 FROM mbox.ticket_dining_collections c JOIN mbox.payments p ON(p.tenant_id,p.store_id,p.id)=(c.tenant_id,c.store_id,c.payment_id)
     WHERE c.tenant_id=t AND c.store_id=s AND c.case_id=case_key
     AND (p.status IN('created','pending') OR (p.status IN('succeeded','partially_refunded','refunded') AND
       p.amount_minor>coalesce((SELECT sum(r.amount_minor) FROM mbox.refunds r WHERE(r.tenant_id,r.store_id,r.payment_id)=(p.tenant_id,p.store_id,p.id) AND r.status='succeeded'),0)))) THEN
     UPDATE mbox.table_ticket_refund_requests SET close_intent=coalesce(close_intent,item.cash_status) WHERE tenant_id=t AND store_id=s AND id=case_key;
     RETURN;
   END IF;
   UPDATE mbox.loyalty_point_lots SET status=CASE WHEN remaining_points=0 THEN 'consumed' ELSE 'available' END
     WHERE tenant_id=t AND store_id=s AND id=item.point_lot_id AND status='ticket_hold';
   UPDATE mbox.table_ticket_refund_requests SET status=coalesce(close_intent,item.cash_status) WHERE tenant_id=t AND store_id=s AND id=case_key;
 END IF;
END $$;
CREATE OR REPLACE FUNCTION mbox.settle_table_ticket_refund() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE case_key uuid;
BEGIN
 SELECT id INTO case_key FROM mbox.table_ticket_refund_requests WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id AND refund_id=NEW.id;
 IF case_key IS NULL THEN SELECT case_id INTO case_key FROM mbox.ticket_dining_collections WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id AND return_refund_id=NEW.id; END IF;
 IF case_key IS NOT NULL THEN PERFORM mbox.finish_ticket_case(NEW.tenant_id,NEW.store_id,case_key); END IF;
 RETURN NEW;
END $$;
-- Cancelled supplements never reopen the ordinary food order for collection.
CREATE OR REPLACE FUNCTION mbox.ticket_dining_due_basis(t uuid,s uuid,o uuid) RETURNS bigint LANGUAGE sql STABLE AS $$
 SELECT coalesce(sum(c.amount_minor),0)::bigint FROM mbox.ticket_dining_collections c
 JOIN mbox.table_ticket_refund_requests f ON (f.tenant_id,f.store_id,f.id)=(c.tenant_id,c.store_id,c.case_id)
 WHERE (c.tenant_id,c.store_id,c.order_id)=(t,s,o) AND c.consented_at IS NOT NULL AND f.status NOT IN('cancelled','rejected')
 AND (f.close_intent IS NULL OR f.close_intent='zero' OR c.payment_id IS NOT NULL)
$$;
UPDATE mbox.normalized_schema_metadata SET schema_version='342',updated_at=clock_timestamp() WHERE singleton;
COMMIT;
