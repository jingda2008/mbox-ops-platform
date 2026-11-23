BEGIN;
CREATE FUNCTION mbox.unissued_late_ticket_payment(t uuid,s uuid,receipt uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT EXISTS(SELECT 1 FROM mbox.payments p JOIN mbox.community_activity_registrations r
   ON (r.tenant_id,r.store_id,r.id,r.payment_id)=(p.tenant_id,p.store_id,p.activity_registration_id,p.id)
   WHERE p.tenant_id=t AND p.store_id=s AND p.id=receipt AND r.service_version=4 AND r.status='cancelled'
   AND p.status='succeeded' AND p.provider_snapshot->'activityLateCaptureRefundRequired'='true'::jsonb
   AND NOT EXISTS(SELECT 1 FROM mbox.table_tickets k WHERE(k.tenant_id,k.store_id,k.registration_id)=(t,s,r.id)))
$$;
CREATE OR REPLACE FUNCTION mbox.guard_table_ticket_refund() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF mbox.unissued_late_ticket_payment(NEW.tenant_id,NEW.store_id,NEW.payment_id)
     AND NEW.status='requested' AND NEW.activity_disposition IS NULL
     AND NEW.amount_minor=(SELECT amount_minor FROM mbox.payments WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id AND id=NEW.payment_id)
     THEN RETURN NEW; END IF;
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
CREATE FUNCTION mbox.ticket_seated_at_original_table(t uuid,s uuid,res uuid,tab uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT EXISTS(SELECT 1 FROM mbox.reservation_seating_batches b JOIN mbox.reservation_seating_sessions ss
   ON (ss.tenant_id,ss.store_id,ss.batch_id)=(b.tenant_id,b.store_id,b.id)
   JOIN mbox.table_sessions active ON(active.tenant_id,active.store_id,active.id)=(ss.tenant_id,ss.store_id,ss.table_session_id)
   WHERE (b.tenant_id,b.store_id,b.reservation_id,ss.table_id_at_seating)=(t,s,res,tab) AND active.table_id=tab AND active.status IN('open','closing'))
$$;
DO $$ DECLARE original text; modified text; BEGIN
 original:=pg_get_functiondef('mbox.table_ticket_area_remaining(uuid,uuid,uuid,timestamptz,timestamptz)'::regprocedure);
 modified:=replace(original,'AND k.refunded_at IS NULL AND l.status IN(''held'',''confirmed'')','AND k.refunded_at IS NULL AND (l.status IN(''held'',''confirmed'') OR (starts<=clock_timestamp() AND l.status=''released'' AND mbox.ticket_seated_at_original_table(t,s,l.reservation_id,l.table_id)))');
 IF modified=original THEN RAISE EXCEPTION 'existing capacity expression missing'; END IF;
 EXECUTE modified;
END $$;
UPDATE mbox.normalized_schema_metadata SET schema_version='344',updated_at=clock_timestamp() WHERE singleton;
COMMIT;
