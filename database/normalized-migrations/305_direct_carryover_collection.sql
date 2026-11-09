BEGIN;
-- Collection scope is independent of preparation and business-day closure.
CREATE FUNCTION mbox.employee_can_collect_carryover(p_tenant uuid,p_store uuid,p_employee uuid,p_order uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog,mbox AS $$
 SELECT p_tenant=mbox.current_tenant_id() AND p_store=mbox.current_store_id()
 AND EXISTS(SELECT 1 FROM mbox.employees e JOIN mbox.orders o ON (o.tenant_id,o.store_id)=(e.tenant_id,e.store_id)
 JOIN mbox.table_sessions s ON (s.tenant_id,s.store_id,s.id)=(o.tenant_id,o.store_id,o.table_session_id)
 WHERE (e.tenant_id,e.store_id,e.id,o.id)=(p_tenant,p_store,p_employee,p_order) AND e.status='active'
 AND (mbox.employee_has_effective_permission(p_tenant,p_store,p_employee,'payment.history.collect')
   OR mbox.employee_has_effective_permission(p_tenant,p_store,p_employee,'payment.collect.all_tables')
   OR EXISTS(SELECT 1 FROM mbox.table_assignments a WHERE (a.tenant_id,a.store_id,a.table_id,a.employee_id)=(p_tenant,p_store,s.table_id,p_employee)
     AND a.assignment_type IN('primary','backup') AND a.starts_at<=clock_timestamp() AND (a.ends_at IS NULL OR a.ends_at>clock_timestamp()))))
$$;
REVOKE ALL ON FUNCTION mbox.employee_can_collect_carryover(uuid,uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mbox.employee_can_collect_carryover(uuid,uuid,uuid,uuid) TO mbox_runtime;

-- Direct collection records the agreed invoice and the payment in one command
-- transaction. The original review endpoint still supports an explicit zero-debt decision.
CREATE FUNCTION mbox.prepare_carryover_collection(p_tenant uuid,p_store uuid,p_order uuid,p_employee uuid,p_amount bigint,p_basis jsonb,p_reason text,p_provider text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,mbox AS $$
DECLARE session_id uuid; basis jsonb;
BEGIN
 IF p_tenant IS DISTINCT FROM mbox.current_tenant_id() OR p_store IS DISTINCT FROM mbox.current_store_id()
 OR NOT EXISTS(SELECT 1 FROM mbox.employees WHERE tenant_id=p_tenant AND store_id=p_store AND id=p_employee AND status='active')
 OR NOT mbox.employee_can_collect_carryover(p_tenant,p_store,p_employee,p_order)
 OR NOT COALESCE(mbox.employee_has_effective_permission(p_tenant,p_store,p_employee,CASE p_provider
 WHEN 'cash' THEN 'payment.manual.cash.record' WHEN 'physical_pos' THEN 'payment.manual.pos.record'
 WHEN 'external_manual' THEN 'payment.manual.external.record' WHEN 'postar' THEN 'payment.initiate.staff'
 WHEN 'simulation' THEN 'payment.initiate.staff' END),false)
 THEN RAISE EXCEPTION '无权核对跨日挂账' USING ERRCODE='42501'; END IF;
 SELECT table_session_id INTO session_id FROM mbox.orders WHERE tenant_id=p_tenant AND store_id=p_store AND id=p_order;
 PERFORM 1 FROM mbox.table_sessions WHERE tenant_id=p_tenant AND store_id=p_store AND id=session_id FOR UPDATE;
 PERFORM 1 FROM mbox.orders WHERE tenant_id=p_tenant AND store_id=p_store AND id=p_order FOR UPDATE;
 basis:=mbox.carryover_tab_review_basis(p_tenant,p_store,p_order);
 IF basis IS NULL OR p_basis IS DISTINCT FROM basis OR p_amount IS NULL OR p_amount<=0
 OR p_amount<>(basis->>'maximumAmountMinor')::bigint OR p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 4 AND 500
 THEN RAISE EXCEPTION '挂账核对依据已变化或金额无效，请重新读取原单' USING ERRCODE='55000'; END IF;
 INSERT INTO mbox.order_carryover_reviews(tenant_id,store_id,order_id,table_session_id,original_business_date,basis_snapshot)
 VALUES(p_tenant,p_store,p_order,session_id,(basis->>'originalBusinessDate')::date,basis) ON CONFLICT DO NOTHING;
 INSERT INTO mbox.order_carryover_review_decisions(tenant_id,store_id,order_id,employee_id,amount_minor,reason,basis_snapshot)
 VALUES(p_tenant,p_store,p_order,p_employee,p_amount,btrim(p_reason),basis);
 IF p_amount>0 THEN
  INSERT INTO mbox.order_carryover_debts(tenant_id,store_id,order_id,table_session_id,original_business_date,
    receivable_minor,captured_receipts_minor,adjustment_minor_at_close,currency,eligibility,review_reason,closed_at)
  VALUES(p_tenant,p_store,p_order,session_id,(basis->>'originalBusinessDate')::date,p_amount,0,0,basis->>'currency','confirmed',
    '员工发起收款确认原单金额：'||btrim(p_reason),(basis->>'closedAt')::timestamptz);
 END IF;
 RETURN jsonb_build_object('orderId',p_order,'amountMinor',p_amount,'employeeId',p_employee,'reason',btrim(p_reason));
END $$;
REVOKE ALL ON FUNCTION mbox.prepare_carryover_collection(uuid,uuid,uuid,uuid,bigint,jsonb,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mbox.prepare_carryover_collection(uuid,uuid,uuid,uuid,bigint,jsonb,text,text) TO mbox_runtime;

CREATE OR REPLACE FUNCTION mbox.allow_carryover_collection(p_row jsonb,p_session uuid)
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
   OR NOT mbox.employee_can_collect_carryover(mbox.current_tenant_id(),mbox.current_store_id(),employee,(p_row->>'order_id')::uuid)
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

CREATE OR REPLACE FUNCTION mbox.allow_carryover_attempt_update(old_row jsonb,new_row jsonb,p_session uuid)
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
     AND mbox.employee_can_collect_carryover((new_row->>'tenant_id')::uuid,(new_row->>'store_id')::uuid,employee,(new_row->>'order_id')::uuid)
     AND mbox.employee_has_effective_permission((new_row->>'tenant_id')::uuid,(new_row->>'store_id')::uuid,employee,'payment.initiate.staff')
     AND mbox.order_collection_due_amount((new_row->>'tenant_id')::uuid,(new_row->>'store_id')::uuid,(new_row->>'order_id')::uuid)>0;
 END IF;
 RETURN false;
END $$;

CREATE OR REPLACE FUNCTION mbox.allow_carryover_order_projection(old_row jsonb,new_row jsonb,p_session uuid)
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
           AND mbox.employee_can_collect_carryover(tenant,store,collector.id,target)
           AND mbox.employee_has_effective_permission(tenant,store,collector.id,CASE p.provider WHEN 'cash' THEN 'payment.manual.cash.record' WHEN 'physical_pos' THEN 'payment.manual.pos.record' ELSE 'payment.manual.external.record' END))));
END $$;

UPDATE mbox.normalized_schema_metadata SET schema_version='305',updated_at=clock_timestamp()
WHERE singleton=true AND schema_flavor='normalized-core-v1';
COMMIT;
