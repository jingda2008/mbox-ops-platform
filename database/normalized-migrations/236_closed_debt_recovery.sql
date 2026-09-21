BEGIN;

-- This migration adds no closed-table operating privileges. The old closure
-- guard remains intact; only a precisely authorized historical cash receipt is new.
CREATE FUNCTION mbox.allow_closed_debt_manual_payment(p_row jsonb,p_session uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,mbox AS $guard$
DECLARE employee uuid;due bigint;currency_code text;eligible boolean;
BEGIN
 IF p_row->>'payable_kind'<>'order' OR p_row->>'status'<>'succeeded'
   OR p_row->>'provider' NOT IN ('cash','physical_pos','external_manual')
   OR p_row->>'succeeded_at' IS NULL
   OR (p_row->>'tenant_id')::uuid IS DISTINCT FROM mbox.current_tenant_id()
   OR (p_row->>'store_id')::uuid IS DISTINCT FROM mbox.current_store_id()
   OR COALESCE(p_row->'provider_snapshot'->>'collectedByEmployeeId','') !~ '^[0-9a-f-]{36}$' THEN RETURN false;END IF;
 employee:=(p_row->'provider_snapshot'->>'collectedByEmployeeId')::uuid;
 IF NOT EXISTS(SELECT 1 FROM mbox.employees e WHERE (e.tenant_id,e.store_id,e.id)=(mbox.current_tenant_id(),mbox.current_store_id(),employee) AND e.status='active')
   OR NOT mbox.employee_has_effective_permission(mbox.current_tenant_id(),mbox.current_store_id(),employee,'payment.collect.all_tables')
   OR NOT mbox.employee_has_effective_permission(mbox.current_tenant_id(),mbox.current_store_id(),employee,'payment.recollect.authorize')
   OR NOT mbox.employee_has_effective_permission(mbox.current_tenant_id(),mbox.current_store_id(),employee,CASE p_row->>'provider'
     WHEN 'cash' THEN 'payment.manual.cash.record' WHEN 'physical_pos' THEN 'payment.manual.pos.record' ELSE 'payment.manual.external.record' END)
 THEN RETURN false;END IF;
 -- The parent trigger holds the session before this order lock. Actor identity
 -- is authenticated by the API; this guard rechecks that actor's current grants.
 PERFORM orders.id FROM mbox.orders orders WHERE (orders.tenant_id,orders.store_id,orders.id)=(mbox.current_tenant_id(),mbox.current_store_id(),(p_row->>'order_id')::uuid)
   AND orders.table_session_id=p_session FOR UPDATE;
 SELECT mbox.order_collection_due_amount(orders.tenant_id,orders.store_id,orders.id),orders.currency,(orders.status NOT IN ('draft','cancelled') AND session.closed_at IS NOT NULL
    AND EXISTS(SELECT 1 FROM mbox.order_recollection_refund_obligations obligation
      JOIN mbox.order_recollection_authorizations original ON (original.tenant_id,original.store_id,original.id)=(obligation.tenant_id,obligation.store_id,obligation.authorization_id)
      WHERE (obligation.tenant_id,obligation.store_id,obligation.order_id)=(orders.tenant_id,orders.store_id,orders.id)
        AND original.created_at<=session.closed_at)
    AND NOT EXISTS(SELECT 1 FROM mbox.order_recollection_refund_obligations obligation
      JOIN mbox.order_recollection_authorizations original ON (original.tenant_id,original.store_id,original.id)=(obligation.tenant_id,obligation.store_id,obligation.authorization_id)
      WHERE (obligation.tenant_id,obligation.store_id,obligation.order_id)=(orders.tenant_id,orders.store_id,orders.id)
        AND original.created_at>session.closed_at)
    AND NOT EXISTS(SELECT 1 FROM mbox.order_refund_facts refund
      JOIN mbox.refunds original ON (original.tenant_id,original.store_id,original.id)=(refund.tenant_id,refund.store_id,refund.id)
      WHERE (refund.tenant_id,refund.store_id,refund.order_id)=(orders.tenant_id,orders.store_id,orders.id)
        AND refund.status='succeeded' AND original.purpose IS DISTINCT FROM 'service_compensation'
        AND NOT EXISTS(SELECT 1 FROM mbox.item_after_sales_case_refunds quantity WHERE (quantity.tenant_id,quantity.store_id,quantity.refund_id)=(refund.tenant_id,refund.store_id,refund.id))
        AND NOT EXISTS(SELECT 1 FROM mbox.order_recollection_refund_obligations obligation
          WHERE (obligation.tenant_id,obligation.store_id,obligation.order_id,obligation.refund_id)=(refund.tenant_id,refund.store_id,refund.order_id,refund.id)))
    AND mbox.order_collection_due_amount(orders.tenant_id,orders.store_id,orders.id)
      =mbox.order_collection_due_amount_for_mode(orders.tenant_id,orders.store_id,orders.id,true))
 INTO due,currency_code,eligible
 FROM mbox.orders orders JOIN mbox.table_sessions session ON (session.tenant_id,session.store_id,session.id)=(orders.tenant_id,orders.store_id,orders.table_session_id)
 WHERE (orders.tenant_id,orders.store_id,orders.id)=(mbox.current_tenant_id(),mbox.current_store_id(),(p_row->>'order_id')::uuid)
   AND session.id=p_session AND session.status='closed';
 IF NOT COALESCE(eligible,false) OR due<=0 OR due IS DISTINCT FROM (p_row->>'amount_minor')::bigint OR currency_code IS DISTINCT FROM p_row->>'currency' THEN RETURN false;END IF;
 IF EXISTS(SELECT 1 FROM mbox.order_payment_facts payment WHERE (payment.tenant_id,payment.store_id,payment.order_id)=(mbox.current_tenant_id(),mbox.current_store_id(),(p_row->>'order_id')::uuid)
   AND (payment.status IN ('created','pending') OR EXISTS(SELECT 1 FROM mbox.verified_provider_observations observation
     WHERE (observation.tenant_id,observation.store_id,observation.payment_id)=(payment.tenant_id,payment.store_id,payment.id)
       AND observation.observed_status='payment_succeeded' AND observation.consumed_at IS NULL))) THEN RETURN false;END IF;
 RETURN EXISTS(SELECT 1 FROM mbox.order_recollection_authorizations approval
   WHERE (approval.tenant_id,approval.store_id,approval.order_id)=(mbox.current_tenant_id(),mbox.current_store_id(),(p_row->>'order_id')::uuid)
     AND approval.status='active' AND approval.expires_at>clock_timestamp() AND approval.amount_minor=due AND approval.currency=currency_code);
END $guard$;
REVOKE ALL ON FUNCTION mbox.allow_closed_debt_manual_payment(jsonb,uuid) FROM PUBLIC;
-- Only the existing SECURITY DEFINER closure trigger invokes this predicate.
-- Runtime receives no new EXECUTE or table UPDATE privileges.
DO $patch$
DECLARE definition text;needle text:=$old$  IF table_session_status NOT IN ('open','closing') AND NOT closed_write_allowed THEN$old$;
 replacement text:=$new$  IF table_session_status='closed' AND NOT closed_write_allowed THEN
    IF TG_TABLE_NAME='payments' AND TG_OP='INSERT' THEN
      closed_write_allowed:=mbox.allow_closed_debt_manual_payment(new_row,table_session_id_value);
    ELSIF TG_TABLE_NAME='payments' AND TG_OP='UPDATE'
      AND old_row->>'status'='closed' AND new_row->>'status'='succeeded'
      AND old_row->'provider_snapshot'->>'localUnpresentedHistoryClosed'='true' THEN
      -- A contradictory late verified capture is still money. Only the
      -- formally consumed, exactly matching observation can admit this write.
      closed_write_allowed:=EXISTS(SELECT 1 FROM mbox.verified_provider_observations observation
        WHERE (observation.tenant_id,observation.store_id,observation.payment_id)=((new_row->>'tenant_id')::uuid,(new_row->>'store_id')::uuid,(new_row->>'id')::uuid)
          AND observation.observed_status='payment_succeeded' AND observation.consumed_at IS NOT NULL
          AND observation.provider=new_row->>'provider'
          AND observation.provider_transaction_id=new_row->>'provider_transaction_id'
          AND observation.reported_amount_minor=(new_row->>'amount_minor')::bigint
          AND observation.reported_currency=new_row->>'currency'
          AND observation.occurred_at=(new_row->>'succeeded_at')::timestamptz);
    ELSIF TG_TABLE_NAME='orders' AND TG_OP='UPDATE'
      AND new_row->>'payment_status'='paid'
      AND (new_row-ARRAY['payment_status','updated_at']) IS NOT DISTINCT FROM (old_row-ARRAY['payment_status','updated_at']) THEN
      -- Original late captures and authorized manual receipts may settle cash;
      -- no order amount, operating status or ownership is changed.
      closed_write_allowed:=EXISTS(SELECT 1 FROM mbox.orders orders JOIN mbox.table_sessions session
        ON (session.tenant_id,session.store_id,session.id)=(orders.tenant_id,orders.store_id,orders.table_session_id)
        WHERE (orders.tenant_id,orders.store_id,orders.id)=((new_row->>'tenant_id')::uuid,(new_row->>'store_id')::uuid,(new_row->>'id')::uuid)
          AND EXISTS(SELECT 1 FROM mbox.order_recollection_refund_obligations obligation
    JOIN mbox.order_recollection_authorizations original ON (original.tenant_id,original.store_id,original.id)=(obligation.tenant_id,obligation.store_id,obligation.authorization_id)
    WHERE (obligation.tenant_id,obligation.store_id,obligation.order_id)=(orders.tenant_id,orders.store_id,orders.id)
      AND original.created_at<=session.closed_at)
          AND mbox.order_consumption_settled(orders.tenant_id,orders.store_id,orders.id)
          AND COALESCE((SELECT SUM(p.amount_minor) FROM mbox.order_payment_facts p WHERE (p.tenant_id,p.store_id,p.order_id)=(orders.tenant_id,orders.store_id,orders.id) AND p.status IN ('succeeded','partially_refunded','refunded')),0)
            -COALESCE((SELECT SUM(r.amount_minor) FROM mbox.order_refund_facts r WHERE (r.tenant_id,r.store_id,r.order_id)=(orders.tenant_id,orders.store_id,orders.id) AND r.status='succeeded'),0)
            >=mbox.order_receivable_amount(orders.tenant_id,orders.store_id,orders.id));
    END IF;
  END IF;
  IF table_session_status NOT IN ('open','closing') AND NOT closed_write_allowed THEN$new$;
BEGIN
 definition:=pg_get_functiondef('mbox.lock_table_session_for_closure_fact_write()'::regprocedure);
 IF array_length(string_to_array(definition,needle),1)<>2 THEN RAISE EXCEPTION 'unexpected closure guard baseline' USING ERRCODE='55000';END IF;
 EXECUTE replace(definition,needle,replacement);
END $patch$;
DO $batch_guard$
DECLARE definition text;needle text:=$old$      IF (new_row->>'order_id') IS NULL THEN
        RETURN NEW;
      END IF;$old$;
 replacement text:=$new$      IF (new_row->>'order_id') IS NULL THEN
        IF TG_OP='INSERT' AND new_row->>'payable_kind'='order_batch' THEN
          SELECT session.status INTO table_session_status FROM mbox.order_payment_batches batch
          JOIN mbox.table_sessions session ON (session.tenant_id,session.store_id,session.id)=(batch.tenant_id,batch.store_id,batch.table_session_id)
          WHERE (batch.tenant_id,batch.store_id,batch.id)=((new_row->>'tenant_id')::uuid,(new_row->>'store_id')::uuid,(new_row->>'order_batch_id')::uuid)
          FOR SHARE OF session;
          IF table_session_status='closed' THEN RAISE EXCEPTION 'closed historical recovery requires one original order' USING ERRCODE='55000';END IF;
        END IF;
        RETURN NEW;
      END IF;$new$;
BEGIN
 definition:=pg_get_functiondef('mbox.lock_table_session_for_closure_fact_write()'::regprocedure);
 IF array_length(string_to_array(definition,needle),1)<>2 THEN RAISE EXCEPTION 'unexpected batch closure baseline' USING ERRCODE='55000';END IF;
 EXECUTE replace(definition,needle,replacement);
END $batch_guard$;
UPDATE mbox.normalized_schema_metadata SET schema_version='236',updated_at=clock_timestamp() WHERE singleton=true AND schema_flavor='normalized-core-v1';
COMMIT;
