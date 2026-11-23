BEGIN;
SET LOCAL lock_timeout='3s';
ALTER TABLE mbox.loyalty_point_lots DROP CONSTRAINT loyalty_point_lots_status_check,
  ADD CONSTRAINT loyalty_point_lots_status_check CHECK(status IN('available','consumed','expired','reversed','ticket_hold')),
  DROP CONSTRAINT loyalty_point_lots_check2,
  ADD CONSTRAINT loyalty_point_lots_check2 CHECK((status='available' AND remaining_points>0) OR
    (status='ticket_hold' AND source_type='table_ticket') OR (status IN('consumed','expired','reversed') AND remaining_points=0));
CREATE FUNCTION mbox.guard_table_ticket_refund() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM mbox.table_ticket_purchases p JOIN mbox.community_activity_registrations r
     ON (r.tenant_id,r.store_id,r.id)=(p.tenant_id,p.store_id,p.registration_id)
     WHERE r.tenant_id=NEW.tenant_id AND r.store_id=NEW.store_id AND r.payment_id=NEW.payment_id)
  AND NOT EXISTS(SELECT 1 FROM mbox.table_ticket_refund_requests f JOIN mbox.table_tickets k
    ON (k.tenant_id,k.store_id,k.id)=(f.tenant_id,f.store_id,f.ticket_id)
    JOIN mbox.table_ticket_purchases p ON (p.tenant_id,p.store_id,p.registration_id)=(k.tenant_id,k.store_id,k.registration_id)
    JOIN mbox.table_ticket_offers o ON (o.tenant_id,o.store_id,o.id)=(p.tenant_id,p.store_id,p.offer_id)
    WHERE f.tenant_id=NEW.tenant_id AND f.store_id=NEW.store_id AND f.id::text=NEW.provider_snapshot->>'tableTicketCaseId'
      AND k.payment_id=NEW.payment_id AND f.status='review' AND f.refund_id IS NULL AND NEW.amount_minor<=o.price_minor
      AND NEW.status='requested' AND NEW.requested_by_employee_id IS NOT NULL)
    THEN RAISE EXCEPTION 'Original numbered ticket and reviewed refund case required' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guard_table_ticket_refund BEFORE INSERT ON mbox.refunds FOR EACH ROW EXECUTE FUNCTION mbox.guard_table_ticket_refund();
CREATE FUNCTION mbox.settle_table_ticket_refund() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE item record; lot mbox.loyalty_point_lots%ROWTYPE; balance integer;
BEGIN
  SELECT f.id AS case_id,k.id AS ticket_id,k.point_lot_id,k.reservation_lock_id INTO item
    FROM mbox.table_ticket_refund_requests f JOIN mbox.table_tickets k ON (k.tenant_id,k.store_id,k.id)=(f.tenant_id,f.store_id,f.ticket_id)
    WHERE f.tenant_id=NEW.tenant_id AND f.store_id=NEW.store_id AND f.refund_id=NEW.id AND f.status='requested'
    FOR UPDATE OF f,k;
  IF NOT FOUND THEN RETURN NEW; END IF;
  IF item.point_lot_id IS NOT NULL THEN
    SELECT * INTO STRICT lot FROM mbox.loyalty_point_lots WHERE id=item.point_lot_id AND tenant_id=NEW.tenant_id AND store_id=NEW.store_id FOR UPDATE;
  END IF;
  IF NEW.status='succeeded' THEN
    IF item.point_lot_id IS NOT NULL AND lot.status='ticket_hold' THEN
      IF lot.remaining_points>0 THEN
        UPDATE mbox.loyalty_accounts SET available_points=available_points-lot.remaining_points
          WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id AND membership_id=lot.membership_id RETURNING available_points INTO STRICT balance;
        UPDATE mbox.customer_memberships SET points_balance=balance WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id AND id=lot.membership_id;
        INSERT INTO mbox.loyalty_point_ledger(tenant_id,store_id,membership_id,customer_id,entry_type,points_delta,balance_after,
          source_type,source_id,reason,idempotency_key,refund_id,reversal_of_entry_id)
          VALUES(NEW.tenant_id,NEW.store_id,lot.membership_id,lot.customer_id,'reverse',-lot.remaining_points,balance,'refund',item.ticket_id,
            '按原票收回赠分','ticket-refund:'||NEW.id,NEW.id,lot.source_ledger_entry_id);
        INSERT INTO mbox.loyalty_point_lot_movements(tenant_id,store_id,lot_id,movement_type,points_delta,balance_after,source_type,source_id,idempotency_key)
          VALUES(NEW.tenant_id,NEW.store_id,lot.id,'reverse',-lot.remaining_points,0,'refund',NEW.id,'ticket-refund:'||NEW.id);
      END IF;
      UPDATE mbox.loyalty_point_lots SET remaining_points=0,status='reversed' WHERE id=lot.id;
    END IF;
    UPDATE mbox.table_tickets SET refunded_at=coalesce(NEW.completed_at,clock_timestamp()) WHERE id=item.ticket_id;
    -- Only return a lock created for this ticket. Independent reservations and seated tables retain ownership.
    UPDATE mbox.reservation_table_locks l SET status='cancelled' FROM mbox.reservations r
      WHERE l.id=item.reservation_lock_id AND (l.tenant_id,l.store_id,l.reservation_id)=(r.tenant_id,r.store_id,r.id)
        AND r.reservation_snapshot->>'ticketId'=item.ticket_id::text AND r.status IN('pending','confirmed') AND l.status IN('held','confirmed');
    UPDATE mbox.reservations r SET status='cancelled'
      WHERE r.tenant_id=NEW.tenant_id AND r.store_id=NEW.store_id AND r.public_id='ticket-'||item.ticket_id::text
        AND r.reservation_snapshot->>'ticketId'=item.ticket_id::text AND r.status IN('pending','confirmed');
    UPDATE mbox.table_ticket_refund_requests SET status='refunded' WHERE id=item.case_id AND tenant_id=NEW.tenant_id AND store_id=NEW.store_id;
  ELSE
    IF item.point_lot_id IS NOT NULL AND lot.status='ticket_hold' THEN
      UPDATE mbox.loyalty_point_lots SET status=CASE WHEN remaining_points=0 THEN 'consumed' ELSE 'available' END WHERE id=lot.id;
    END IF;
    UPDATE mbox.table_ticket_refund_requests SET status=NEW.status WHERE id=item.case_id AND tenant_id=NEW.tenant_id AND store_id=NEW.store_id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER settle_table_ticket_refund AFTER UPDATE OF status ON mbox.refunds FOR EACH ROW
  WHEN(NEW.status IN('succeeded','rejected','cancelled') AND OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION mbox.settle_table_ticket_refund();
UPDATE mbox.normalized_schema_metadata SET schema_version='329',updated_at=clock_timestamp() WHERE singleton;
COMMIT;
