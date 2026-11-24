BEGIN;
SET LOCAL lock_timeout='3s';
ALTER TABLE mbox.table_ticket_refund_requests
  ADD COLUMN planned_refund_minor integer CHECK(planned_refund_minor>0),
  ADD COLUMN planned_refund_employee uuid,
  ADD COLUMN auto_review_error text,
  ADD CHECK((planned_refund_minor IS NULL)=(planned_refund_employee IS NULL)),
  ADD FOREIGN KEY(tenant_id,store_id,planned_refund_employee) REFERENCES mbox.employees(tenant_id,store_id,id);
GRANT UPDATE(planned_refund_minor,planned_refund_employee,auto_review_error) ON mbox.table_ticket_refund_requests TO mbox_runtime;
CREATE INDEX ticket_ready_for_auto_review ON mbox.table_ticket_refund_requests(tenant_id,store_id,created_at,id)
  WHERE planned_refund_minor IS NOT NULL AND auto_review_error IS NULL AND status='review' AND close_intent IS NULL AND refund_id IS NULL;
CREATE INDEX ticket_cash_reviews_pending ON mbox.table_ticket_refund_requests(tenant_id,store_id,created_at,id)
  WHERE status='requested' AND refund_id IS NOT NULL;
CREATE FUNCTION mbox.ticket_dining_cleared(t uuid,s uuid,f uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT coalesce(bool_and(c.consented_at IS NOT NULL AND (c.amount_minor=0 OR coalesce(
   p.status='succeeded' AND p.order_id=c.order_id AND p.amount_minor=c.amount_minor,false))
   AND NOT EXISTS(SELECT 1 FROM mbox.refunds r WHERE(r.tenant_id,r.store_id,r.payment_id)=(c.tenant_id,c.store_id,p.id)
     AND r.status NOT IN('cancelled','rejected'))),false)
 FROM mbox.ticket_dining_collections c LEFT JOIN mbox.payments p ON(p.tenant_id,p.store_id,p.id)=(c.tenant_id,c.store_id,c.payment_id)
 WHERE (c.tenant_id,c.store_id,c.case_id)=(t,s,f) AND c.superseded_at IS NULL
$$;
REVOKE ALL ON FUNCTION mbox.ticket_dining_cleared(uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mbox.ticket_dining_cleared(uuid,uuid,uuid) TO mbox_runtime;
UPDATE mbox.normalized_schema_metadata SET schema_version='367',updated_at=clock_timestamp() WHERE singleton;
COMMIT;
