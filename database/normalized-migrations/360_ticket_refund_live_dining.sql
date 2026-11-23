BEGIN;
-- A dining payment can settle or a dish can be returned while the ticket is frozen.
CREATE FUNCTION mbox.ticket_refund_basis(t uuid,s uuid,ticket uuid)
RETURNS TABLE(consumed_minor bigint,unresolved boolean,requires_review boolean)
LANGUAGE sql STABLE AS $$
 WITH source AS (
   SELECT k.point_lot_id,l.status,l.membership_id,p.membership_id AS buyer,
     EXISTS(SELECT 1 FROM mbox.table_ticket_corrections c WHERE (c.tenant_id,c.store_id,c.ticket_id)=(t,s,ticket) AND c.status='requested') AS correcting,
     k.point_lot_id IS NULL AND EXISTS(SELECT 1 FROM mbox.loyalty_point_ledger e
       WHERE (e.tenant_id,e.store_id,e.source_id)=(t,s,ticket::text) AND e.source_type='activity' AND e.entry_type='earn') AS unlinked
   FROM mbox.table_tickets k JOIN mbox.table_ticket_purchases p USING(tenant_id,store_id,registration_id)
   LEFT JOIN mbox.loyalty_point_lots l ON (l.tenant_id,l.store_id,l.id)=(t,s,k.point_lot_id)
   WHERE (k.tenant_id,k.store_id,k.id)=(t,s,ticket)
 ), basis AS (
   SELECT u.amount,source.correcting OR source.unlinked OR
     coalesce(source.membership_id<>source.buyer OR source.status='reversed',false) OR u.held AS blocked,
     u.partial
   FROM source CROSS JOIN LATERAL (
     SELECT coalesce(sum(coalesce((SELECT sum(ps.amount_minor-coalesce(r.returned_minor,0))
       FROM mbox.checkout_point_portion_sources ps
       LEFT JOIN mbox.checkout_returned_sources(t,s,a.quote_id) r ON (r.portion_id,r.lot_id)=(ps.portion_id,ps.lot_id)
       WHERE (ps.tenant_id,ps.store_id,ps.quote_id,ps.lot_id)=(t,s,a.quote_id,a.lot_id)),(a.points::bigint-a.restored_points)*100))
       FILTER(WHERE h.status='consumed'),0)::bigint AS amount,
       coalesce(bool_or(h.status='held'),false) AS held,
       coalesce(bool_or(a.restored_points>0 AND a.restored_points<a.points),false) AS partial
     FROM mbox.checkout_point_lots a JOIN mbox.checkout_point_holds h USING(tenant_id,store_id,quote_id)
     WHERE a.tenant_id=t AND a.store_id=s AND a.lot_id IN(SELECT mbox.ticket_spending_lots(t,s,source.point_lot_id))
   ) u
 ) SELECT amount,blocked,blocked OR partial OR amount>0 FROM basis
$$;
-- Retain the reviewed figures when an open case goes to the channel or a final decision.
CREATE FUNCTION mbox.snapshot_ticket_refund_basis() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 SELECT b.consumed_minor,b.requires_review INTO STRICT NEW.consumed_minor,NEW.source_review_required
 FROM mbox.ticket_refund_basis(OLD.tenant_id,OLD.store_id,OLD.ticket_id) b;
 RETURN NEW;
END $$;
CREATE TRIGGER snapshot_ticket_refund_basis BEFORE UPDATE OF status,close_intent ON mbox.table_ticket_refund_requests
 FOR EACH ROW WHEN (OLD.status='review' AND OLD.close_intent IS NULL AND (NEW.status<>OLD.status OR NEW.close_intent IS NOT NULL))
 EXECUTE FUNCTION mbox.snapshot_ticket_refund_basis();

-- A new proposal needs its own identifier so a stale customer screen cannot accept revised prices.
ALTER TABLE mbox.ticket_dining_collections ADD COLUMN superseded_at timestamptz,
 ADD CHECK(superseded_at IS NULL OR (consented_at IS NULL AND payment_id IS NULL));
DO $$ DECLARE previous_name name; BEGIN
 SELECT conname INTO STRICT previous_name FROM pg_constraint
 WHERE conrelid='mbox.ticket_dining_collections'::regclass AND contype='u'
 AND pg_get_constraintdef(oid)='UNIQUE (tenant_id, store_id, case_id, order_id)';
 EXECUTE format('ALTER TABLE mbox.ticket_dining_collections DROP CONSTRAINT %I',previous_name);
END $$;
CREATE UNIQUE INDEX ticket_dining_current_proposal ON mbox.ticket_dining_collections(tenant_id,store_id,case_id,order_id) WHERE superseded_at IS NULL;
GRANT UPDATE(superseded_at) ON mbox.ticket_dining_collections TO mbox_runtime;
-- A confirmed original-order supplement has its own approval and amount.
CREATE FUNCTION mbox.ticket_pending_dining(t uuid,s uuid,o uuid)
RETURNS TABLE(id uuid,case_id uuid,amount_minor bigint) LANGUAGE sql STABLE AS $$
 SELECT c.id,c.case_id,c.amount_minor FROM mbox.ticket_dining_collections c
 JOIN mbox.table_ticket_refund_requests f ON(f.tenant_id,f.store_id,f.id)=(t,s,c.case_id)
 LEFT JOIN mbox.payments p ON(p.tenant_id,p.store_id,p.id)=(t,s,c.payment_id)
 WHERE (c.tenant_id,c.store_id,c.order_id)=(t,s,o) AND c.consented_at IS NOT NULL
 AND f.status='review' AND f.close_intent IS NULL AND
 (c.payment_id IS NULL OR p.status IN('failed','closed','created','pending'))
$$;
-- Re-read the original portions under the order lock when a new receipt is actually recorded.
CREATE FUNCTION mbox.guard_ticket_dining_capture() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE bill record;
BEGIN
 SELECT c.id,c.line_snapshot,k.point_lot_id INTO bill
 FROM mbox.ticket_pending_dining(NEW.tenant_id,NEW.store_id,NEW.order_id) d
 JOIN mbox.ticket_dining_collections c ON c.id=d.id
 JOIN mbox.table_ticket_refund_requests f ON f.id=c.case_id AND (f.tenant_id,f.store_id)=(c.tenant_id,c.store_id)
 JOIN mbox.table_tickets k ON (k.tenant_id,k.store_id,k.id)=(f.tenant_id,f.store_id,f.ticket_id)
 FOR SHARE OF f,c;
 IF NOT FOUND THEN RETURN NEW; END IF;
 IF EXISTS(SELECT 1 FROM mbox.item_after_sales_cases a WHERE (a.tenant_id,a.store_id,a.order_id)=(NEW.tenant_id,NEW.store_id,NEW.order_id) AND a.status IN('requested','approved'))
 OR EXISTS(SELECT 1 FROM mbox.order_refund_facts r WHERE (r.tenant_id,r.store_id,r.order_id)=(NEW.tenant_id,NEW.store_id,NEW.order_id) AND r.status NOT IN('succeeded','rejected','cancelled'))
 OR EXISTS(
   WITH expected AS (
     SELECT (item->>'portionId')::uuid portion,sum((item->>'usedMinor')::bigint) amount
     FROM jsonb_array_elements(bill.line_snapshot) item GROUP BY 1
   ), actual AS (
     SELECT ps.portion_id portion,sum(ps.amount_minor-coalesce(r.returned_minor,0)) amount
     FROM mbox.checkout_coupon_order_links link JOIN mbox.checkout_point_portion_sources ps USING(tenant_id,store_id,quote_id)
     JOIN mbox.checkout_point_holds h USING(tenant_id,store_id,quote_id)
     LEFT JOIN mbox.checkout_returned_sources(link.tenant_id,link.store_id,link.quote_id) r ON (r.portion_id,r.lot_id)=(ps.portion_id,ps.lot_id)
     WHERE (link.tenant_id,link.store_id,link.order_id)=(NEW.tenant_id,NEW.store_id,NEW.order_id)
     AND ps.lot_id IN(SELECT mbox.ticket_spending_lots(link.tenant_id,link.store_id,bill.point_lot_id)) AND h.status='consumed'
     GROUP BY ps.portion_id HAVING sum(ps.amount_minor-coalesce(r.returned_minor,0))>0
   ) SELECT 1 FROM expected FULL JOIN actual USING(portion) WHERE expected.amount IS DISTINCT FROM actual.amount
 ) THEN RAISE EXCEPTION '原菜款或退菜记录已变化，请先核对原售后，撤回旧补款后按当前明细重新确认'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guard_ticket_dining_capture BEFORE INSERT ON mbox.payments FOR EACH ROW
 WHEN (NEW.payable_kind='order') EXECUTE FUNCTION mbox.guard_ticket_dining_capture();
-- Reuse the existing closed-table staff, tender and unresolved-payment checks.
DO $$ DECLARE body text; marker text; BEGIN
 body:=pg_get_functiondef('mbox.allow_closed_debt_manual_payment(jsonb,uuid)'::regprocedure);
 marker:=' IF NOT COALESCE(eligible,false)';
 IF position(marker IN body)=0 THEN RAISE EXCEPTION 'missing closed receipt amount guard'; END IF;
 body:=replace(body,marker,$code$
 IF EXISTS(SELECT 1 FROM mbox.ticket_pending_dining(mbox.current_tenant_id(),mbox.current_store_id(),(p_row->>'order_id')::uuid) d
   WHERE d.amount_minor=(p_row->>'amount_minor')::bigint AND d.id::text=p_row->'provider_snapshot'->>'ticketDiningApprovalId')
 THEN eligible:=true; END IF;
$code$||marker);
 marker:=' RETURN EXISTS(SELECT 1 FROM mbox.order_recollection_authorizations approval';
 IF position(marker IN body)=0 THEN RAISE EXCEPTION 'missing closed receipt authority guard'; END IF;
 EXECUTE replace(body,marker,$code$
 IF EXISTS(SELECT 1 FROM mbox.ticket_pending_dining(mbox.current_tenant_id(),mbox.current_store_id(),(p_row->>'order_id')::uuid) d
   WHERE d.amount_minor=due AND d.id::text=p_row->'provider_snapshot'->>'ticketDiningApprovalId')
 THEN RETURN true; END IF;
$code$||marker);
 body:=pg_get_functiondef('mbox.record_closed_debt_manual_payment_admission()'::regprocedure);
 -- The existing AFTER link trigger has already recorded the verified payment on the confirmed proposal.
 EXECUTE replace(body,'BEGIN', $code$BEGIN
 IF NEW.provider_snapshot ? 'ticketDiningApprovalId' AND EXISTS(SELECT 1 FROM mbox.ticket_dining_collections c
   WHERE (c.tenant_id,c.store_id,c.order_id,c.payment_id)=(NEW.tenant_id,NEW.store_id,NEW.order_id,NEW.id)
   AND c.id::text=NEW.provider_snapshot->>'ticketDiningApprovalId' AND c.consented_at IS NOT NULL AND c.amount_minor=NEW.amount_minor)
 THEN RETURN NEW; END IF;$code$);
END $$;
-- On a closed original order only its payment-status projection may follow the confirmed supplement and its refund.
CREATE FUNCTION mbox.ticket_dining_payment_status(t uuid,s uuid,o uuid,session_id uuid) RETURNS text
LANGUAGE sql STABLE AS $$
 SELECT CASE WHEN gross-total_back>=mbox.order_receivable_amount(t,s,o) THEN 'paid'
             WHEN total_back>0 AND gross<=total_back THEN 'refunded' WHEN total_back>0 THEN 'partially_refunded'
             WHEN gross>0 THEN 'partially_paid' ELSE 'unpaid' END
 FROM mbox.orders ord CROSS JOIN LATERAL (
   SELECT coalesce(sum(p.amount_minor),0) gross FROM mbox.order_payment_facts p
   WHERE (p.tenant_id,p.store_id,p.order_id)=(t,s,o) AND p.status IN('succeeded','partially_refunded','refunded')
 ) paid CROSS JOIN LATERAL (
   SELECT coalesce(sum(r.amount_minor),0) total_back FROM mbox.order_refund_facts r
   WHERE (r.tenant_id,r.store_id,r.order_id)=(t,s,o) AND r.status='succeeded'
 ) returned
 WHERE (ord.tenant_id,ord.store_id,ord.id,ord.table_session_id)=(t,s,o,session_id)
 AND (t,s)=(mbox.current_tenant_id(),mbox.current_store_id())
 AND EXISTS(SELECT 1 FROM mbox.ticket_dining_collections c WHERE (c.tenant_id,c.store_id,c.order_id)=(t,s,o) AND c.consented_at IS NOT NULL)
 AND NOT EXISTS(SELECT 1 FROM mbox.order_carryover_debts d WHERE (d.tenant_id,d.store_id,d.order_id)=(t,s,o))
$$;
DO $$ DECLARE body text; marker text:='  IF table_session_status NOT IN (''open'',''closing'') AND NOT closed_write_allowed THEN';
BEGIN
 body:=pg_get_functiondef('mbox.lock_table_session_for_closure_fact_write()'::regprocedure);
 IF position(marker IN body)=0 THEN RAISE EXCEPTION 'missing final closed table guard'; END IF;
 EXECUTE replace(body,marker,$code$
  IF NOT closed_write_allowed AND table_session_status='closed' AND TG_TABLE_NAME='orders' AND TG_OP='UPDATE'
    AND (new_row-ARRAY['payment_status','updated_at']) IS NOT DISTINCT FROM (old_row-ARRAY['payment_status','updated_at'])
    AND new_row->>'payment_status'=mbox.ticket_dining_payment_status((new_row->>'tenant_id')::uuid,(new_row->>'store_id')::uuid,(new_row->>'id')::uuid,table_session_id_value)
  THEN closed_write_allowed:=true; END IF;
$code$||marker);
END $$;
-- The venue's independently reviewed ticket refund can finish before an earlier dining payment settles.
ALTER TABLE mbox.table_ticket_refund_requests ADD COLUMN merchant_assumes_dining boolean NOT NULL DEFAULT false;
GRANT UPDATE(merchant_assumes_dining) ON mbox.table_ticket_refund_requests TO mbox_runtime;
CREATE OR REPLACE FUNCTION mbox.ticket_dining_due_basis(t uuid,s uuid,o uuid) RETURNS bigint LANGUAGE sql STABLE AS $$
 SELECT coalesce(sum(c.amount_minor),0)::bigint FROM mbox.ticket_dining_collections c
 JOIN mbox.table_ticket_refund_requests f ON (f.tenant_id,f.store_id,f.id)=(c.tenant_id,c.store_id,c.case_id)
 WHERE (c.tenant_id,c.store_id,c.order_id)=(t,s,o) AND c.consented_at IS NOT NULL AND f.status NOT IN('cancelled','rejected')
 AND NOT f.merchant_assumes_dining AND (f.close_intent IS NULL OR f.close_intent='zero' OR c.payment_id IS NOT NULL)
$$;

CREATE FUNCTION mbox.queue_merchant_dining_return() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE bill record; target_case uuid; target_payment uuid; refund_key uuid;
BEGIN
 IF (NEW.tenant_id,NEW.store_id) IS DISTINCT FROM (mbox.current_tenant_id(),mbox.current_store_id()) THEN RETURN NULL; END IF;
 IF TG_TABLE_NAME='payments' THEN target_payment:=NEW.id; ELSE target_case:=NEW.id; END IF;
 FOR bill IN SELECT c.id,c.order_id,c.payment_id,c.amount_minor,ticket_cash.requested_by_employee_id AS employee
   FROM mbox.ticket_dining_collections c
   JOIN mbox.table_ticket_refund_requests f ON (f.tenant_id,f.store_id,f.id)=(c.tenant_id,c.store_id,c.case_id)
   JOIN mbox.refunds ticket_cash ON (ticket_cash.tenant_id,ticket_cash.store_id,ticket_cash.id)=(f.tenant_id,f.store_id,f.refund_id)
   JOIN mbox.payments p ON (p.tenant_id,p.store_id,p.id,p.order_id)=(c.tenant_id,c.store_id,c.payment_id,c.order_id)
   WHERE (c.tenant_id,c.store_id)=(NEW.tenant_id,NEW.store_id) AND (c.case_id=target_case OR c.payment_id=target_payment)
     AND f.merchant_assumes_dining AND f.status='refunded' AND ticket_cash.status='succeeded'
     AND c.consented_at IS NOT NULL AND c.return_refund_id IS NULL AND p.status='succeeded' AND p.amount_minor=c.amount_minor
   ORDER BY c.id FOR UPDATE OF c,p
 LOOP
   IF EXISTS(SELECT 1 FROM mbox.refunds r WHERE (r.tenant_id,r.store_id,r.payment_id)=(NEW.tenant_id,NEW.store_id,bill.payment_id)
     AND r.status NOT IN('rejected','cancelled')) THEN CONTINUE; END IF;
   INSERT INTO mbox.refunds(tenant_id,store_id,payment_id,order_id,public_id,amount_minor,currency,status,reason,requested_by_employee_id,provider_snapshot)
     VALUES(NEW.tenant_id,NEW.store_id,bill.payment_id,bill.order_id,'TDM'||replace(bill.id::text,'-',''),bill.amount_minor,'CNY','requested',
       '门店承担餐饮差额，按原补款回单退回',bill.employee,jsonb_build_object('diningCollection',bill.id::text))
     RETURNING id INTO refund_key;
   UPDATE mbox.ticket_dining_collections SET return_refund_id=refund_key WHERE (tenant_id,store_id,id)=(NEW.tenant_id,NEW.store_id,bill.id);
 END LOOP;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION mbox.queue_merchant_dining_return() FROM PUBLIC;
CREATE TRIGGER queue_merchant_dining_on_ticket AFTER UPDATE OF status ON mbox.table_ticket_refund_requests FOR EACH ROW
 WHEN(NEW.merchant_assumes_dining AND NEW.status='refunded' AND OLD.status<>NEW.status) EXECUTE FUNCTION mbox.queue_merchant_dining_return();
CREATE TRIGGER queue_merchant_dining_on_capture AFTER UPDATE OF status ON mbox.payments FOR EACH ROW
 WHEN(NEW.payable_kind='order' AND NEW.status='succeeded' AND OLD.status<>NEW.status) EXECUTE FUNCTION mbox.queue_merchant_dining_return();

DO $$ DECLARE owner_name name; BEGIN
 SELECT pg_get_userbyid(proowner) INTO STRICT owner_name FROM pg_proc WHERE oid='mbox.lock_table_session_for_closure_fact_write()'::regprocedure;
 EXECUTE format('GRANT SELECT(tenant_id,store_id,id,case_id,order_id,amount_minor,consented_at,payment_id) ON mbox.ticket_dining_collections TO %I',owner_name);
 EXECUTE format('GRANT SELECT(tenant_id,store_id,id,status,close_intent,merchant_assumes_dining) ON mbox.table_ticket_refund_requests TO %I',owner_name);
 SELECT pg_get_userbyid(proowner) INTO STRICT owner_name FROM pg_proc WHERE oid='mbox.prepare_after_sales_price(uuid)'::regprocedure;
 EXECUTE format('GRANT SELECT(merchant_assumes_dining) ON mbox.table_ticket_refund_requests TO %I',owner_name);
END $$;
UPDATE mbox.normalized_schema_metadata SET schema_version='360',updated_at=clock_timestamp() WHERE singleton;
COMMIT;
