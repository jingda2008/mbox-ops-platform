BEGIN;
-- Keep a mistaken account's lot frozen for an independent review even when the channel refunds first.
DO $$ DECLARE original text; marker text:='IF NOT pending_correction AND item.point_lot_id IS NOT NULL AND lot.status=''ticket_hold'' THEN';
BEGIN
 original:=pg_get_functiondef('mbox.finish_ticket_case(uuid,uuid,uuid)'::regprocedure);
 IF position(marker IN original)=0 THEN RAISE EXCEPTION 'missing coordinated ticket refund handler'; END IF;
 EXECUTE replace(original,marker,'IF NOT pending_correction AND item.point_lot_id IS NOT NULL AND lot.status=''ticket_hold''
   AND EXISTS (SELECT 1 FROM mbox.table_tickets k JOIN mbox.table_ticket_purchases p USING(tenant_id,store_id,registration_id)
     WHERE k.tenant_id=t AND k.store_id=s AND k.id=item.ticket_id AND p.membership_id=lot.membership_id) THEN');
END $$;

-- Only the original, independently reviewed correction may update a refund's recorded allocation.
CREATE FUNCTION mbox.reconcile_corrected_ticket_refund() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF OLD.status='requested' AND NEW.status='approved' AND NEW.replacement_lot_id IS NOT NULL
    AND NEW.tenant_id=mbox.current_tenant_id() AND NEW.store_id=mbox.current_store_id() THEN
   UPDATE mbox.table_ticket_refund_requests f SET frozen_points=l.remaining_points,
     consumed_minor=CASE WHEN NEW.consumption_resolution='merchant_assumes' THEN 0 ELSE f.consumed_minor END,
     source_review_required=NEW.consumption_resolution<>'merchant_assumes' AND f.consumed_minor>0
   FROM mbox.table_tickets k JOIN mbox.loyalty_point_lots l ON (l.tenant_id,l.store_id,l.id)=(k.tenant_id,k.store_id,k.point_lot_id)
   WHERE (f.tenant_id,f.store_id,f.ticket_id)=(NEW.tenant_id,NEW.store_id,NEW.ticket_id)
     AND (k.tenant_id,k.store_id,k.id)=(f.tenant_id,f.store_id,f.ticket_id)
     AND l.id=NEW.replacement_lot_id AND l.membership_id=NEW.target_membership_id AND l.status='ticket_hold'
     AND f.status='review' AND f.close_intent IS NULL AND f.refund_id IS NULL;
 END IF;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION mbox.reconcile_corrected_ticket_refund() FROM PUBLIC;
CREATE TRIGGER reconcile_corrected_ticket_refund AFTER UPDATE OF status ON mbox.table_ticket_corrections
 FOR EACH ROW EXECUTE FUNCTION mbox.reconcile_corrected_ticket_refund();
UPDATE mbox.normalized_schema_metadata SET schema_version='357',updated_at=clock_timestamp() WHERE singleton;
COMMIT;
