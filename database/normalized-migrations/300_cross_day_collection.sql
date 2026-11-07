BEGIN;

-- Capture only FUTURE closures. An old automatic-cutoff exception is not
-- sufficient evidence to silently restore a debt or charge a customer again.
CREATE TABLE mbox.order_carryover_debts (
 tenant_id uuid NOT NULL, store_id uuid NOT NULL, order_id uuid NOT NULL,
 table_session_id uuid NOT NULL, original_business_date date NOT NULL,
 receivable_minor bigint NOT NULL CHECK(receivable_minor>0),
 captured_receipts_minor bigint NOT NULL CHECK(captured_receipts_minor>=0),
 adjustment_minor_at_close bigint NOT NULL,
 currency char(3) NOT NULL, eligibility text NOT NULL CHECK(eligibility IN('confirmed','review_required')),
 review_reason text, closed_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,store_id,order_id),
 FOREIGN KEY(tenant_id,store_id,order_id) REFERENCES mbox.orders(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,store_id,table_session_id) REFERENCES mbox.table_sessions(tenant_id,store_id,id)
);
ALTER TABLE mbox.order_carryover_debts ENABLE ROW LEVEL SECURITY;
ALTER TABLE mbox.order_carryover_debts FORCE ROW LEVEL SECURITY;
CREATE POLICY carryover_debt_scope ON mbox.order_carryover_debts
 USING(tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id())
 WITH CHECK(tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id());
CREATE TRIGGER carryover_debt_immutable BEFORE UPDATE OR DELETE ON mbox.order_carryover_debts
 FOR EACH ROW EXECUTE FUNCTION mbox.reject_row_change();
REVOKE ALL ON mbox.order_carryover_debts FROM PUBLIC,mbox_runtime;
GRANT SELECT ON mbox.order_carryover_debts TO mbox_runtime;

CREATE FUNCTION mbox.capture_closed_table_debts() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,mbox AS $$
DECLARE o record; delivered bigint; item_total bigint; receipts bigint; receivable bigint; needs_review boolean;
BEGIN
 IF OLD.status NOT IN('open','closing') OR NEW.status<>'closed'
   OR NEW.tenant_id IS DISTINCT FROM mbox.current_tenant_id() OR NEW.store_id IS DISTINCT FROM mbox.current_store_id() THEN RETURN NEW; END IF;
 FOR o IN SELECT * FROM mbox.orders WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id
   AND table_session_id=NEW.id AND status<>'draft' ORDER BY id FOR UPDATE LOOP
   IF o.status='cancelled' AND NOT EXISTS(SELECT 1 FROM mbox.order_cancellation_events c
     WHERE (c.tenant_id,c.store_id,c.order_id)=(o.tenant_id,o.store_id,o.id)
       AND c.reason_code IN('automatic_cutoff','guest_left') AND c.occurred_at>=transaction_timestamp()) THEN CONTINUE; END IF;
   -- Genuine waiver, bad-debt approval and test cleanup remain terminal.
   IF EXISTS(SELECT 1 FROM mbox.order_settlement_exception_events e
     WHERE (e.tenant_id,e.store_id,e.order_id)=(o.tenant_id,o.store_id,o.id)
       AND e.reason_code NOT IN('automatic_cutoff','customer_left')) THEN CONTINUE; END IF;
   SELECT COALESCE(sum(amount_minor),0) INTO receipts FROM mbox.order_payment_facts
     WHERE (tenant_id,store_id,order_id)=(o.tenant_id,o.store_id,o.id) AND status IN('succeeded','partially_refunded','refunded');
   receivable:=mbox.order_receivable_amount(o.tenant_id,o.store_id,o.id);
   -- Paid invoices need no new debt inference (including settled bundle repricing).
   IF receivable IS NULL OR receivable<=receipts THEN CONTINUE; END IF;
   needs_review:=false;
   BEGIN
     SELECT COALESCE(sum(CASE WHEN i.status='delivered' OR EXISTS(SELECT 1 FROM mbox.order_item_quantity_units u
         WHERE (u.tenant_id,u.store_id,u.order_item_id)=(i.tenant_id,i.store_id,i.id)
           AND mbox.quantity_unit_has_delivery(u.tenant_id,u.store_id,u.id))
       THEN mbox.quantity_delivered_item_amount(i.tenant_id,i.store_id,i.id) ELSE 0 END),0),
       COALESCE(sum(i.total_amount_minor),0) INTO delivered,item_total
     FROM mbox.order_items i WHERE (i.tenant_id,i.store_id,i.order_id)=(o.tenant_id,o.store_id,o.id);
   EXCEPTION WHEN SQLSTATE '55000' THEN
     -- Missing original per-unit allocation is a review case, never a reason
     -- to invent collectible prices or prevent an otherwise valid closure.
     needs_review:=true;delivered:=receivable;item_total:=receivable;
   END;
   IF delivered<=0 THEN CONTINUE; END IF;
   receivable:=CASE WHEN needs_review OR delivered=item_total THEN receivable ELSE LEAST(delivered,receivable) END;
   IF receivable<=receipts THEN CONTINUE; END IF;
   needs_review:=needs_review OR delivered<item_total AND (o.total_amount_minor<>item_total OR EXISTS(
     SELECT 1 FROM mbox.item_receivable_adjustment_facts a WHERE (a.tenant_id,a.store_id,a.order_id)=(o.tenant_id,o.store_id,o.id)));
   INSERT INTO mbox.order_carryover_debts(tenant_id,store_id,order_id,table_session_id,original_business_date,
     receivable_minor,captured_receipts_minor,adjustment_minor_at_close,currency,eligibility,review_reason,closed_at)
   VALUES(o.tenant_id,o.store_id,o.id,NEW.id,o.business_date,receivable,receipts,(SELECT COALESCE(sum(a.amount_minor),0) FROM mbox.item_receivable_adjustment_facts a
       WHERE (a.tenant_id,a.store_id,a.order_id)=(o.tenant_id,o.store_id,o.id)),o.currency,
     CASE WHEN needs_review THEN 'review_required' ELSE 'confirmed' END,
     CASE WHEN needs_review THEN '部分履约含折扣、售后调整或分摊价格不完整；金额仅供核对，不能直接补收' END,COALESCE(NEW.closed_at,clock_timestamp()))
   ON CONFLICT DO NOTHING;
 END LOOP;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION mbox.capture_closed_table_debts() FROM PUBLIC;
CREATE TRIGGER table_session_capture_carryover_debts AFTER UPDATE OF status ON mbox.table_sessions
 FOR EACH ROW EXECUTE FUNCTION mbox.capture_closed_table_debts();

-- Closed consumption is fixed. New or existing after-sales facts require human
-- review; this feature must not infer that a refund authorizes a fresh charge.
CREATE FUNCTION mbox.carryover_collection_eligibility(p_tenant uuid,p_store uuid,p_order uuid)
RETURNS text LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog,mbox AS $$
 SELECT CASE WHEN d.eligibility='review_required' OR EXISTS(SELECT 1 FROM mbox.order_refund_facts f
     WHERE (f.tenant_id,f.store_id,f.order_id)=(p_tenant,p_store,p_order))
   OR d.adjustment_minor_at_close<>(SELECT COALESCE(sum(a.amount_minor),0) FROM mbox.item_receivable_adjustment_facts a
     WHERE (a.tenant_id,a.store_id,a.order_id)=(p_tenant,p_store,p_order)) THEN 'review_required' ELSE 'confirmed' END
 FROM mbox.order_carryover_debts d WHERE (d.tenant_id,d.store_id,d.order_id)=(p_tenant,p_store,p_order)
$$;
REVOKE ALL ON FUNCTION mbox.carryover_collection_eligibility(uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mbox.carryover_collection_eligibility(uuid,uuid,uuid) TO mbox_runtime;

-- Retain the existing ordinary/refund semantics for every non-enrolled order.
ALTER FUNCTION mbox.order_collection_due_amount_for_mode(uuid,uuid,uuid,boolean)
 RENAME TO order_collection_due_amount_before_carryover;
CREATE FUNCTION mbox.order_collection_due_amount_for_mode(p_tenant uuid,p_store uuid,p_order uuid,p_allow_ordinary_refunds boolean)
RETURNS bigint LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog,mbox AS $$
 SELECT CASE WHEN debt.order_id IS NULL THEN mbox.order_collection_due_amount_before_carryover(p_tenant,p_store,p_order,p_allow_ordinary_refunds)
 ELSE GREATEST(0,debt.receivable_minor
   -COALESCE((SELECT sum(amount_minor) FROM mbox.order_payment_facts p
     WHERE (p.tenant_id,p.store_id,p.order_id)=(p_tenant,p_store,p_order) AND p.status IN('succeeded','partially_refunded','refunded')),0)
   +COALESCE((SELECT sum(f.amount_minor) FROM mbox.order_refund_facts f JOIN mbox.refunds r
     ON (r.tenant_id,r.store_id,r.id)=(f.tenant_id,f.store_id,f.id)
     WHERE (f.tenant_id,f.store_id,f.order_id)=(p_tenant,p_store,p_order) AND f.status='succeeded'
       AND r.purpose IS DISTINCT FROM 'service_compensation'
       AND (p_allow_ordinary_refunds OR EXISTS(SELECT 1 FROM mbox.order_recollection_refund_obligations a
         WHERE (a.tenant_id,a.store_id,a.order_id,a.refund_id)=(p_tenant,p_store,p_order,f.id)))),0))::bigint END
 FROM (SELECT 1) seed LEFT JOIN mbox.order_carryover_debts debt
 ON (debt.tenant_id,debt.store_id,debt.order_id)=(p_tenant,p_store,p_order)
$$;
REVOKE ALL ON FUNCTION mbox.order_collection_due_amount_for_mode(uuid,uuid,uuid,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mbox.order_collection_due_amount_for_mode(uuid,uuid,uuid,boolean) TO mbox_runtime;
CREATE OR REPLACE FUNCTION mbox.order_collection_due_amount(p_tenant uuid,p_store uuid,p_order uuid)
RETURNS bigint LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog,mbox AS $$
 SELECT mbox.order_collection_due_amount_for_mode(p_tenant,p_store,p_order,false)
$$;

CREATE FUNCTION mbox.order_financial_receivable_amount(p_tenant uuid,p_store uuid,p_order uuid)
RETURNS bigint LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog,mbox AS $$
 SELECT COALESCE((SELECT receivable_minor FROM mbox.order_carryover_debts
   WHERE (tenant_id,store_id,order_id)=(p_tenant,p_store,p_order) AND eligibility='confirmed'),mbox.order_receivable_amount(p_tenant,p_store,p_order))
$$;
REVOKE ALL ON FUNCTION mbox.order_financial_receivable_amount(uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mbox.order_financial_receivable_amount(uuid,uuid,uuid) TO mbox_runtime;

-- A retired operational order with a proven consumed balance is not an
-- unfulfilled cancelled sale. Preserve its excess-money signal separately.
DO $monitor$
DECLARE definition text;
BEGIN
 definition:=rtrim(pg_get_viewdef('mbox.payment_financial_monitoring_signals'::regclass,true),E';\n ');
 EXECUTE 'CREATE OR REPLACE VIEW mbox.payment_financial_monitoring_signals WITH(security_invoker=true) AS
 SELECT * FROM ('||definition||') old_signal WHERE NOT (old_signal.signal IN(''order_overcollected'',''cancelled_order_captured'')
   AND EXISTS(SELECT 1 FROM mbox.order_carryover_debts d WHERE (d.tenant_id,d.store_id,d.order_id)=(old_signal.tenant_id,old_signal.store_id,old_signal.subject_id) AND d.eligibility=''confirmed''))
 UNION ALL SELECT d.tenant_id,d.store_id,d.order_id,''order_overcollected''::text,max(p.succeeded_at)
 FROM mbox.order_carryover_debts d JOIN mbox.order_payment_facts p
 ON (p.tenant_id,p.store_id,p.order_id)=(d.tenant_id,d.store_id,d.order_id)
 WHERE p.status IN(''succeeded'',''partially_refunded'',''refunded'') AND d.eligibility=''confirmed''
 GROUP BY d.tenant_id,d.store_id,d.order_id,d.receivable_minor
 HAVING sum(p.amount_minor)-COALESCE((SELECT sum(r.amount_minor) FROM mbox.order_refund_facts r
   WHERE (r.tenant_id,r.store_id,r.order_id)=(d.tenant_id,d.store_id,d.order_id) AND r.status=''succeeded''),0)>d.receivable_minor';
END $monitor$;

CREATE FUNCTION mbox.carryover_payment_status(p_tenant uuid,p_store uuid,p_order uuid)
RETURNS text LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog,mbox AS $$
 SELECT CASE WHEN receipts.amount-refunds.amount>=d.receivable_minor THEN 'paid'
   WHEN refunds.amount>0 AND receipts.amount-refunds.amount<=0 THEN 'refunded'
   WHEN refunds.amount>0 THEN 'partially_refunded'
   WHEN receipts.amount>0 THEN 'partially_paid' ELSE 'unpaid' END
 FROM mbox.order_carryover_debts d
 CROSS JOIN LATERAL(SELECT COALESCE(sum(p.amount_minor),0) AS amount FROM mbox.order_payment_facts p
   WHERE (p.tenant_id,p.store_id,p.order_id)=(d.tenant_id,d.store_id,d.order_id) AND p.status IN('succeeded','partially_refunded','refunded')) receipts
 CROSS JOIN LATERAL(SELECT COALESCE(sum(r.amount_minor),0) AS amount FROM mbox.order_refund_facts r
   WHERE (r.tenant_id,r.store_id,r.order_id)=(d.tenant_id,d.store_id,d.order_id) AND r.status='succeeded') refunds
 WHERE (d.tenant_id,d.store_id,d.order_id)=(p_tenant,p_store,p_order)
$$;
REVOKE ALL ON FUNCTION mbox.carryover_payment_status(uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mbox.carryover_payment_status(uuid,uuid,uuid) TO mbox_runtime;

CREATE FUNCTION mbox.allow_carryover_collection(p_row jsonb,p_session uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,mbox AS $$
DECLARE employee uuid; due bigint; allowed_provider boolean;
BEGIN
 IF p_row->>'payable_kind'<>'order' OR COALESCE(p_row->'provider_snapshot'->>'collectedByEmployeeId','') !~ '^[0-9a-f-]{36}$'
   OR (p_row->>'tenant_id')::uuid IS DISTINCT FROM mbox.current_tenant_id()
   OR (p_row->>'store_id')::uuid IS DISTINCT FROM mbox.current_store_id() THEN RETURN false; END IF;
 employee:=(p_row->'provider_snapshot'->>'collectedByEmployeeId')::uuid;
 IF NOT EXISTS(SELECT 1 FROM mbox.order_carryover_debts d JOIN mbox.table_sessions s
   ON (s.tenant_id,s.store_id,s.id)=(d.tenant_id,d.store_id,d.table_session_id)
   WHERE (d.tenant_id,d.store_id,d.order_id,d.table_session_id)=(mbox.current_tenant_id(),mbox.current_store_id(),(p_row->>'order_id')::uuid,p_session)
     AND mbox.carryover_collection_eligibility(d.tenant_id,d.store_id,d.order_id)='confirmed' AND s.status='closed' AND d.currency=p_row->>'currency')
   OR NOT mbox.employee_has_effective_permission(mbox.current_tenant_id(),mbox.current_store_id(),employee,'payment.history.collect')
   OR NOT EXISTS(SELECT 1 FROM mbox.employees e WHERE (e.tenant_id,e.store_id,e.id)=(mbox.current_tenant_id(),mbox.current_store_id(),employee) AND e.status='active') THEN RETURN false; END IF;
 allowed_provider:=CASE p_row->>'provider'
   WHEN 'cash' THEN p_row->>'status'='succeeded' AND mbox.employee_has_effective_permission(mbox.current_tenant_id(),mbox.current_store_id(),employee,'payment.manual.cash.record')
   WHEN 'physical_pos' THEN p_row->>'status'='succeeded' AND mbox.employee_has_effective_permission(mbox.current_tenant_id(),mbox.current_store_id(),employee,'payment.manual.pos.record')
   WHEN 'external_manual' THEN p_row->>'status'='succeeded' AND mbox.employee_has_effective_permission(mbox.current_tenant_id(),mbox.current_store_id(),employee,'payment.manual.external.record')
   WHEN 'postar' THEN p_row->>'status' IN('created','pending') AND mbox.employee_has_effective_permission(mbox.current_tenant_id(),mbox.current_store_id(),employee,'payment.initiate.staff')
   WHEN 'simulation' THEN p_row->>'status' IN('created','pending') AND mbox.employee_has_effective_permission(mbox.current_tenant_id(),mbox.current_store_id(),employee,'payment.initiate.staff')
   ELSE false END;
 IF NOT COALESCE(allowed_provider,false) THEN RETURN false; END IF;
 due:=mbox.order_collection_due_amount(mbox.current_tenant_id(),mbox.current_store_id(),(p_row->>'order_id')::uuid);
 RETURN (p_row->>'amount_minor')::bigint>0 AND (p_row->>'amount_minor')::bigint<=due;
END $$;
REVOKE ALL ON FUNCTION mbox.allow_carryover_collection(jsonb,uuid) FROM PUBLIC;

-- Attempt preparation/retry is not a receipt. Never admit amount, ownership,
-- currency, succeeded_at or captured status changes through these branches.
CREATE FUNCTION mbox.allow_carryover_attempt_update(old_row jsonb,new_row jsonb,p_session uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,mbox AS $$
DECLARE employee uuid;
BEGIN
 IF old_row->>'status' NOT IN('created','pending') OR old_row->>'provider' NOT IN('postar','simulation')
   OR NOT EXISTS(SELECT 1 FROM mbox.order_carryover_debts d WHERE (d.tenant_id,d.store_id,d.order_id,d.table_session_id)=
     ((old_row->>'tenant_id')::uuid,(old_row->>'store_id')::uuid,(old_row->>'order_id')::uuid,p_session)) THEN RETURN false; END IF;
 IF (new_row-ARRAY['provider_transaction_id','provider_snapshot','updated_at']) IS NOT DISTINCT FROM (old_row-ARRAY['provider_transaction_id','provider_snapshot','updated_at'])
   AND (old_row->>'provider_transaction_id' IS NULL OR old_row->>'provider_transaction_id'=new_row->>'provider_transaction_id')
   AND (new_row->'provider_snapshot'-ARRAY['providerStatus','providerPresentation','providerOrderCreatedAt']) IS NOT DISTINCT FROM (old_row->'provider_snapshot'-ARRAY['providerStatus','providerPresentation','providerOrderCreatedAt'])
   AND EXISTS(SELECT 1 FROM mbox.payment_provider_actions a WHERE (a.tenant_id,a.store_id,a.payment_id)=
     ((new_row->>'tenant_id')::uuid,(new_row->>'store_id')::uuid,(new_row->>'id')::uuid) AND a.state='ready') THEN RETURN true; END IF;
 IF new_row->>'status'='failed' AND (new_row-ARRAY['status','provider_snapshot','updated_at']) IS NOT DISTINCT FROM (old_row-ARRAY['status','provider_snapshot','updated_at'])
   AND (new_row->'provider_snapshot'-ARRAY['providerStatus','errorCode']) IS NOT DISTINCT FROM (old_row->'provider_snapshot'-ARRAY['providerStatus','errorCode'])
   AND EXISTS(SELECT 1 FROM mbox.payment_provider_actions a WHERE (a.tenant_id,a.store_id,a.payment_id)=
     ((new_row->>'tenant_id')::uuid,(new_row->>'store_id')::uuid,(new_row->>'id')::uuid) AND a.state='failed') THEN RETURN true; END IF;
 IF old_row->>'retry_released_at' IS NULL AND new_row->>'retry_released_at' IS NOT NULL
   AND (new_row-ARRAY['retry_released_at','retry_released_by_employee_id','retry_release_reason','retry_release_idempotency_key','provider_snapshot','updated_at'])
     IS NOT DISTINCT FROM (old_row-ARRAY['retry_released_at','retry_released_by_employee_id','retry_release_reason','retry_release_idempotency_key','provider_snapshot','updated_at'])
   AND (new_row->'provider_snapshot'-ARRAY['retryReleasedAt','retryReleaseReason']) IS NOT DISTINCT FROM (old_row->'provider_snapshot'-ARRAY['retryReleasedAt','retryReleaseReason']) THEN
   employee:=(new_row->>'retry_released_by_employee_id')::uuid;
   RETURN EXISTS(SELECT 1 FROM mbox.employees e WHERE (e.tenant_id,e.store_id,e.id)=((new_row->>'tenant_id')::uuid,(new_row->>'store_id')::uuid,employee) AND e.status='active')
     AND mbox.employee_has_effective_permission((new_row->>'tenant_id')::uuid,(new_row->>'store_id')::uuid,employee,'payment.history.collect')
     AND mbox.employee_has_effective_permission((new_row->>'tenant_id')::uuid,(new_row->>'store_id')::uuid,employee,'payment.initiate.staff')
     AND mbox.order_collection_due_amount((new_row->>'tenant_id')::uuid,(new_row->>'store_id')::uuid,(new_row->>'order_id')::uuid)>0;
 END IF;
 RETURN false;
END $$;
REVOKE ALL ON FUNCTION mbox.allow_carryover_attempt_update(jsonb,jsonb,uuid) FROM PUBLIC;

CREATE FUNCTION mbox.allow_carryover_order_projection(old_row jsonb,new_row jsonb,p_session uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,mbox AS $$
DECLARE tenant uuid:=(new_row->>'tenant_id')::uuid;store uuid:=(new_row->>'store_id')::uuid;target uuid:=(new_row->>'id')::uuid;
BEGIN
 IF tenant IS DISTINCT FROM mbox.current_tenant_id() OR store IS DISTINCT FROM mbox.current_store_id()
   OR (new_row-ARRAY['payment_status','updated_at']) IS DISTINCT FROM (old_row-ARRAY['payment_status','updated_at'])
   OR new_row->>'payment_status' IS DISTINCT FROM mbox.carryover_payment_status(tenant,store,target)
   OR NOT EXISTS(SELECT 1 FROM mbox.order_carryover_debts d WHERE (d.tenant_id,d.store_id,d.order_id,d.table_session_id)=(tenant,store,target,p_session)) THEN RETURN false; END IF;
 IF old_row->>'payment_status'=new_row->>'payment_status' THEN RETURN true; END IF;
 -- Every newly captured receipt must have one exact immutable whole-payment
 -- ledger. A mere pending row, timestamp edit or unconsumed observation cannot
 -- project a closed invoice into a paid state.
 IF EXISTS(SELECT 1 FROM mbox.order_payment_facts f JOIN mbox.payments p ON (p.tenant_id,p.store_id,p.id)=(f.tenant_id,f.store_id,f.id)
   JOIN mbox.order_carryover_debts d ON (d.tenant_id,d.store_id,d.order_id)=(f.tenant_id,f.store_id,f.order_id)
   WHERE (f.tenant_id,f.store_id,f.order_id)=(tenant,store,target) AND f.status IN('succeeded','partially_refunded','refunded') AND p.created_at>=d.closed_at
     AND ((SELECT count(*) FROM mbox.reconciliation_entries e WHERE (e.tenant_id,e.store_id,e.payment_id)=(tenant,store,p.id) AND e.entry_type='payment')<>1
       OR NOT EXISTS(SELECT 1 FROM mbox.reconciliation_entries e WHERE (e.tenant_id,e.store_id,e.payment_id)=(tenant,store,p.id)
         AND e.entry_type='payment' AND e.refund_id IS NULL AND e.amount_minor=p.amount_minor AND e.currency=p.currency
         AND e.provider=p.provider AND e.provider_reference=p.provider_transaction_id))) THEN RETURN false; END IF;
 -- A separately approved refund has its own causal proof. The employee who
 -- originally collected cash need not retain collection rights forever.
 IF new_row->>'payment_status' IN('partially_refunded','refunded') AND EXISTS(
   SELECT 1 FROM mbox.order_refund_facts f JOIN mbox.refunds r ON (r.tenant_id,r.store_id,r.id)=(f.tenant_id,f.store_id,f.id)
   JOIN mbox.payments p ON (p.tenant_id,p.store_id,p.id)=(r.tenant_id,r.store_id,r.payment_id)
   JOIN mbox.reconciliation_entries e ON (e.tenant_id,e.store_id,e.refund_id,e.payment_id)=(r.tenant_id,r.store_id,r.id,r.payment_id)
   WHERE (f.tenant_id,f.store_id,f.order_id)=(tenant,store,target) AND r.status='succeeded'
     AND r.xmin=pg_current_xact_id()::text::xid AND e.xmin=pg_current_xact_id()::text::xid
     AND r.approved_by_employee_id IS NOT NULL AND r.approved_by_employee_id<>r.requested_by_employee_id
     AND e.entry_type='refund' AND e.amount_minor=-r.amount_minor AND e.currency=r.currency
     AND e.provider=p.provider AND e.provider_reference=r.provider_refund_id
     AND (p.provider IN('cash','physical_pos','external_manual') AND e.evidence_snapshot->>'receiptReference'=r.provider_refund_id
       OR EXISTS(SELECT 1 FROM mbox.verified_provider_observations v WHERE (v.tenant_id,v.store_id,v.refund_id)=(tenant,store,r.id)
         AND v.observed_status='refund_succeeded' AND v.consumed_at IS NOT NULL AND v.provider_transaction_id=r.provider_refund_id
         AND v.reported_amount_minor=r.amount_minor AND v.reported_currency=r.currency))) THEN RETURN true; END IF;
 RETURN EXISTS(SELECT 1 FROM mbox.payments p JOIN mbox.reconciliation_entries e ON (e.tenant_id,e.store_id,e.payment_id)=(p.tenant_id,p.store_id,p.id)
   WHERE (p.tenant_id,p.store_id)=(tenant,store) AND EXISTS(SELECT 1 FROM mbox.order_payment_facts allocation
       WHERE (allocation.tenant_id,allocation.store_id,allocation.id,allocation.order_id)=(tenant,store,p.id,target))
     AND p.status IN('succeeded','partially_refunded','refunded')
     AND p.xmin=pg_current_xact_id()::text::xid
     AND e.entry_type='payment' AND e.refund_id IS NULL AND e.amount_minor=p.amount_minor AND e.currency=p.currency
     AND e.provider=p.provider AND e.provider_reference=p.provider_transaction_id
     AND (EXISTS(SELECT 1 FROM mbox.verified_provider_observations v WHERE (v.tenant_id,v.store_id,v.payment_id)=(tenant,store,p.id)
       AND v.observed_status='payment_succeeded' AND v.consumed_at IS NOT NULL AND v.provider_transaction_id=p.provider_transaction_id
       AND v.reported_amount_minor=p.amount_minor AND v.reported_currency=p.currency)
       OR p.provider IN('cash','physical_pos','external_manual') AND EXISTS(SELECT 1 FROM mbox.employees collector
         WHERE (collector.tenant_id,collector.store_id)=(tenant,store) AND collector.id::text=p.provider_snapshot->>'collectedByEmployeeId' AND collector.status='active'
           AND e.evidence_snapshot->>'collectedByEmployeeId'=collector.id::text
           AND e.evidence_snapshot->>'receiptReference'=p.provider_transaction_id
           AND mbox.employee_has_effective_permission(tenant,store,collector.id,'payment.history.collect')
           AND mbox.employee_has_effective_permission(tenant,store,collector.id,CASE p.provider WHEN 'cash' THEN 'payment.manual.cash.record' WHEN 'physical_pos' THEN 'payment.manual.pos.record' ELSE 'payment.manual.external.record' END))));
END $$;
REVOKE ALL ON FUNCTION mbox.allow_carryover_order_projection(jsonb,jsonb,uuid) FROM PUBLIC;

DO $guard$
DECLARE definition text; needle text:='  IF table_session_status NOT IN (''open'',''closing'') AND NOT closed_write_allowed THEN';
BEGIN
 definition:=pg_get_functiondef('mbox.lock_table_session_for_closure_fact_write()'::regprocedure);
 definition:=replace(definition,'  IF NOT should_lock THEN',$force$
  IF TG_TABLE_NAME='orders' AND TG_OP='UPDATE' AND EXISTS(SELECT 1 FROM mbox.order_carryover_debts d
    WHERE (d.tenant_id,d.store_id,d.order_id)=((new_row->>'tenant_id')::uuid,(new_row->>'store_id')::uuid,(new_row->>'id')::uuid)) THEN should_lock:=true; END IF;
  IF NOT should_lock THEN$force$);
 IF array_length(string_to_array(definition,needle),1)<>2 THEN RAISE EXCEPTION 'Unexpected closure guard baseline'; END IF;
 EXECUTE replace(definition,needle,$patch$
  IF table_session_status='closed' AND (NOT closed_write_allowed OR (TG_TABLE_NAME='orders' AND EXISTS(
    SELECT 1 FROM mbox.order_carryover_debts d WHERE (d.tenant_id,d.store_id,d.order_id)=((new_row->>'tenant_id')::uuid,(new_row->>'store_id')::uuid,(new_row->>'id')::uuid)))) THEN
    IF TG_TABLE_NAME='payments' AND TG_OP='INSERT' THEN
      closed_write_allowed:=mbox.allow_carryover_collection(new_row,table_session_id_value);
    ELSIF TG_TABLE_NAME='payments' AND TG_OP='UPDATE' THEN
      closed_write_allowed:=mbox.allow_carryover_attempt_update(old_row,new_row,table_session_id_value);
    ELSIF TG_TABLE_NAME='orders' AND TG_OP='UPDATE'
      AND (new_row-ARRAY['payment_status','updated_at']) IS NOT DISTINCT FROM (old_row-ARRAY['payment_status','updated_at']) THEN
      closed_write_allowed:=mbox.allow_carryover_order_projection(old_row,new_row,table_session_id_value);
    END IF;
  END IF;
$patch$||needle);
 -- Legacy authorization receipts continue to use their original guard.
 definition:=pg_get_functiondef('mbox.record_closed_debt_manual_payment_admission()'::regprocedure);
 EXECUTE replace(definition,'BEGIN', 'BEGIN
 IF EXISTS(SELECT 1 FROM mbox.order_carryover_debts d WHERE (d.tenant_id,d.store_id,d.order_id)=(NEW.tenant_id,NEW.store_id,NEW.order_id)) THEN RETURN NEW; END IF;');
END $guard$;

CREATE FUNCTION mbox.seed_store_history_collection_permission() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO mbox.staff_permission_definitions(tenant_id,store_id,code,name,category,description)
 VALUES(NEW.tenant_id,NEW.id,'payment.history.collect','收取历史欠款','finance','查询并收取已确认的历史欠款；不授予减免、退款或恢复旧账权限')
 ON CONFLICT DO NOTHING;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION mbox.seed_store_history_collection_permission() FROM PUBLIC;
CREATE TRIGGER stores_seed_history_collection AFTER INSERT ON mbox.stores
 FOR EACH ROW EXECUTE FUNCTION mbox.seed_store_history_collection_permission();

INSERT INTO mbox.staff_permission_definitions(tenant_id,store_id,code,name,category,description)
 SELECT tenant_id,id,'payment.history.collect','收取历史欠款','finance','查询并收取已确认的历史欠款；不授予减免、退款或恢复旧账权限'
 FROM mbox.stores ON CONFLICT(tenant_id,store_id,code) DO NOTHING;
INSERT INTO mbox.role_permission_assignments(tenant_id,store_id,role_id,permission_id)
 SELECT r.tenant_id,r.store_id,r.id,p.id FROM mbox.roles r JOIN mbox.staff_permission_definitions p
 ON (p.tenant_id,p.store_id)=(r.tenant_id,r.store_id) AND p.code='payment.history.collect'
 WHERE r.status='active' AND r.code IN('CASHIER','MANAGER','OWNER','ADMIN')
 ON CONFLICT DO NOTHING;

CREATE OR REPLACE FUNCTION mbox.operating_day_summary(p_tenant uuid,p_store uuid,p_date date)
RETURNS jsonb LANGUAGE sql STABLE AS $summary$
 WITH day_orders AS (
   SELECT o.*,mbox.order_financial_receivable_amount(o.tenant_id,o.store_id,o.id) AS effective_minor
   FROM mbox.orders o WHERE o.tenant_id=p_tenant AND o.store_id=p_store AND o.business_date=p_date
     AND (o.status NOT IN ('draft','cancelled') OR EXISTS(SELECT 1 FROM mbox.order_carryover_debts d WHERE (d.tenant_id,d.store_id,d.order_id)=(o.tenant_id,o.store_id,o.id) AND d.eligibility='confirmed'))
 ), amounts AS (
   SELECT o.id,o.total_amount_minor,o.effective_minor,
     mbox.order_collection_due_amount(o.tenant_id,o.store_id,o.id) AS outstanding
   FROM day_orders o
 ) SELECT jsonb_build_object(
   'orderCount',(SELECT count(*) FROM amounts),
   'originalOrderAmountMinor',(SELECT COALESCE(sum(total_amount_minor),0)::text FROM amounts),
   'stoppedAmountMinor',(SELECT COALESCE(sum(total_amount_minor-effective_minor),0)::text FROM amounts),
   'orderAmountMinor',(SELECT COALESCE(sum(effective_minor),0)::text FROM amounts),
   'unsettledCount',(SELECT count(*) FROM amounts WHERE outstanding>0),
   'outstandingMinor',(SELECT COALESCE(sum(outstanding),0)::text FROM amounts),
   'pendingPaymentCount',0,
   'pendingRefundCount',(SELECT count(*) FROM mbox.refunds r
     WHERE r.tenant_id=p_tenant AND r.store_id=p_store AND r.status IN ('requested','approved','processing','failed')
       AND NOT EXISTS(SELECT 1 FROM mbox.item_after_sales_refund_retries superseded WHERE superseded.tenant_id=r.tenant_id AND superseded.store_id=r.store_id AND superseded.previous_refund_id=r.id)
       AND EXISTS(SELECT 1 FROM mbox.order_payment_facts p JOIN mbox.orders o ON o.tenant_id=p.tenant_id AND o.store_id=p.store_id AND o.id=p.order_id
         WHERE p.tenant_id=r.tenant_id AND p.store_id=r.store_id AND p.id=r.payment_id AND (r.order_id IS NULL OR r.order_id=p.order_id) AND o.business_date=p_date)))
$summary$;

UPDATE mbox.normalized_schema_metadata SET schema_version='300',updated_at=clock_timestamp()
 WHERE singleton=true AND schema_flavor='normalized-core-v1';
COMMIT;
