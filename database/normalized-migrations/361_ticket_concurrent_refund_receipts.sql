BEGIN;

-- Take the same parent-first locks as a dining capture before either receipt
-- can affect the membership or finish the ticket. The later callback then
-- sees the committed result of the earlier one, even on separate connections.
CREATE FUNCTION mbox.lock_ticket_dining_for_merchant_refund() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  original_orders uuid[];
  supplement_payments uuid[];
BEGIN
  SELECT array_agg(DISTINCT c.order_id),array_agg(DISTINCT c.payment_id)
    INTO original_orders,supplement_payments
    FROM mbox.table_ticket_refund_requests f
    JOIN mbox.ticket_dining_collections c ON (c.tenant_id,c.store_id,c.case_id)=(f.tenant_id,f.store_id,f.id)
    WHERE (f.tenant_id,f.store_id,f.refund_id)=(NEW.tenant_id,NEW.store_id,NEW.id)
      AND f.merchant_assumes_dining AND c.consented_at IS NOT NULL AND c.payment_id IS NOT NULL;
  IF original_orders IS NULL THEN RETURN NEW; END IF;

  PERFORM session.id FROM mbox.table_sessions session
    WHERE (session.tenant_id,session.store_id)=(NEW.tenant_id,NEW.store_id)
      AND EXISTS(SELECT 1 FROM mbox.orders o WHERE (o.tenant_id,o.store_id,o.table_session_id)=(session.tenant_id,session.store_id,session.id)
        AND o.id=ANY(original_orders))
    ORDER BY session.id FOR SHARE;
  PERFORM id FROM mbox.orders
    WHERE (tenant_id,store_id)=(NEW.tenant_id,NEW.store_id) AND id=ANY(original_orders)
    ORDER BY id FOR UPDATE;
  PERFORM id FROM mbox.payments
    WHERE (tenant_id,store_id)=(NEW.tenant_id,NEW.store_id) AND id=ANY(supplement_payments)
    ORDER BY id FOR UPDATE;
  RETURN NEW;
END $$;
CREATE TRIGGER lock_ticket_dining_for_merchant_refund BEFORE UPDATE OF status ON mbox.refunds
  FOR EACH ROW WHEN (NEW.status='succeeded' AND OLD.status<>NEW.status AND NEW.provider_snapshot ? 'tableTicketCaseId')
  EXECUTE FUNCTION mbox.lock_ticket_dining_for_merchant_refund();

UPDATE mbox.normalized_schema_metadata SET schema_version='361',updated_at=clock_timestamp() WHERE singleton;
COMMIT;
