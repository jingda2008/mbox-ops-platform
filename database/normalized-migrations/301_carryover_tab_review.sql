BEGIN;

-- A deferred staff tab is a review candidate, never proof of consumption.
-- No historical rows are inserted by this migration.
CREATE TABLE mbox.order_carryover_reviews (
 tenant_id uuid NOT NULL, store_id uuid NOT NULL, order_id uuid NOT NULL,
 table_session_id uuid NOT NULL, original_business_date date NOT NULL,
 basis_snapshot jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,store_id,order_id),
 FOREIGN KEY(tenant_id,store_id,order_id) REFERENCES mbox.orders(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,store_id,table_session_id) REFERENCES mbox.table_sessions(tenant_id,store_id,id)
);
CREATE TABLE mbox.order_carryover_review_decisions (
 tenant_id uuid NOT NULL, store_id uuid NOT NULL, order_id uuid NOT NULL,
 employee_id uuid NOT NULL, amount_minor bigint NOT NULL CHECK(amount_minor>=0 AND amount_minor<=9007199254740991),
 reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 4 AND 500),
 basis_snapshot jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,store_id,order_id),
 FOREIGN KEY(tenant_id,store_id,order_id) REFERENCES mbox.orders(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,store_id,employee_id) REFERENCES mbox.employees(tenant_id,store_id,id)
);
ALTER TABLE mbox.order_carryover_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE mbox.order_carryover_reviews FORCE ROW LEVEL SECURITY;
ALTER TABLE mbox.order_carryover_review_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE mbox.order_carryover_review_decisions FORCE ROW LEVEL SECURITY;
CREATE POLICY carryover_review_scope ON mbox.order_carryover_reviews
 USING(tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id())
 WITH CHECK(tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id());
CREATE POLICY carryover_review_decision_scope ON mbox.order_carryover_review_decisions
 USING(tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id())
 WITH CHECK(tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id());
CREATE TRIGGER carryover_review_immutable BEFORE UPDATE OR DELETE ON mbox.order_carryover_reviews
 FOR EACH ROW EXECUTE FUNCTION mbox.reject_row_change();
CREATE TRIGGER carryover_review_decision_immutable BEFORE UPDATE OR DELETE ON mbox.order_carryover_review_decisions
 FOR EACH ROW EXECUTE FUNCTION mbox.reject_row_change();
REVOKE ALL ON mbox.order_carryover_reviews,mbox.order_carryover_review_decisions FROM PUBLIC,mbox_runtime;
GRANT SELECT ON mbox.order_carryover_reviews,mbox.order_carryover_review_decisions TO mbox_runtime;

CREATE FUNCTION mbox.carryover_tab_review_candidate(p_tenant uuid,p_store uuid,p_order uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog,mbox AS $$
 SELECT jsonb_build_object('orderId',o.id,'tableSessionId',s.id,'originalBusinessDate',o.business_date,
   'closedAt',s.closed_at,'cancellationId',c.id,'maximumAmountMinor',o.total_amount_minor,
   'currency',o.currency,'orderNote',o.note,'reason','挂桌账在营业日截止时自动取消，尚未确认实际消费及未收金额')
 FROM mbox.orders o JOIN mbox.table_sessions s
 ON (s.tenant_id,s.store_id,s.id)=(o.tenant_id,o.store_id,o.table_session_id)
 JOIN mbox.order_cancellation_events c ON (c.tenant_id,c.store_id,c.order_id)=(o.tenant_id,o.store_id,o.id)
 WHERE (o.tenant_id,o.store_id,o.id)=(p_tenant,p_store,p_order)
 AND p_tenant=mbox.current_tenant_id() AND p_store=mbox.current_store_id()
 AND o.channel='staff_assisted' AND o.settlement_mode='table_tab' AND o.status='cancelled'
 AND s.status='closed' AND o.total_amount_minor>0 AND o.total_amount_minor<=9007199254740991
 AND c.reason_code='automatic_cutoff' AND c.actor_type='system'
 AND c.occurred_at BETWEEN s.closed_at-interval '5 seconds' AND s.closed_at
 AND NOT EXISTS(SELECT 1 FROM mbox.order_carryover_debts d WHERE (d.tenant_id,d.store_id,d.order_id)=(p_tenant,p_store,p_order))
 AND NOT EXISTS(SELECT 1 FROM mbox.order_carryover_review_decisions d WHERE (d.tenant_id,d.store_id,d.order_id)=(p_tenant,p_store,p_order))
 AND NOT EXISTS(SELECT 1 FROM mbox.order_settlement_exception_events e WHERE (e.tenant_id,e.store_id,e.order_id)=(p_tenant,p_store,p_order) AND e.reason_code NOT IN('automatic_cutoff','customer_left'))
 AND COALESCE((SELECT sum(p.amount_minor) FROM mbox.order_payment_facts p WHERE (p.tenant_id,p.store_id,p.order_id)=(p_tenant,p_store,p_order)
   AND p.status IN('succeeded','partially_refunded','refunded')),0)<o.total_amount_minor
 ORDER BY c.occurred_at DESC LIMIT 1
$$;
REVOKE ALL ON FUNCTION mbox.carryover_tab_review_candidate(uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mbox.carryover_tab_review_candidate(uuid,uuid,uuid) TO mbox_runtime;

-- Keep complex candidates visible, but admit only a clean, explicit review.
CREATE FUNCTION mbox.carryover_tab_review_basis(p_tenant uuid,p_store uuid,p_order uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog,mbox AS $$
 SELECT candidate FROM (SELECT mbox.carryover_tab_review_candidate(p_tenant,p_store,p_order) candidate) source
 WHERE candidate IS NOT NULL
 AND NOT EXISTS(SELECT 1 FROM mbox.order_settlement_exception_events e WHERE (e.tenant_id,e.store_id,e.order_id)=(p_tenant,p_store,p_order))
 AND NOT EXISTS(SELECT 1 FROM mbox.item_receivable_adjustment_facts a WHERE (a.tenant_id,a.store_id,a.order_id)=(p_tenant,p_store,p_order))
 AND NOT EXISTS(SELECT 1 FROM mbox.order_payment_facts p WHERE (p.tenant_id,p.store_id,p.order_id)=(p_tenant,p_store,p_order))
 AND NOT EXISTS(SELECT 1 FROM mbox.order_refund_facts r WHERE (r.tenant_id,r.store_id,r.order_id)=(p_tenant,p_store,p_order))
 AND NOT EXISTS(SELECT 1 FROM mbox.checkout_coupon_order_links l WHERE (l.tenant_id,l.store_id,l.order_id)=(p_tenant,p_store,p_order))
$$;
REVOKE ALL ON FUNCTION mbox.carryover_tab_review_basis(uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mbox.carryover_tab_review_basis(uuid,uuid,uuid) TO mbox_runtime;

CREATE FUNCTION mbox.capture_closed_table_tab_reviews() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,mbox AS $$
DECLARE candidate record; basis jsonb;
BEGIN
 IF OLD.status NOT IN('open','closing') OR NEW.status<>'closed'
 OR NEW.tenant_id IS DISTINCT FROM mbox.current_tenant_id() OR NEW.store_id IS DISTINCT FROM mbox.current_store_id() THEN RETURN NEW; END IF;
 FOR candidate IN SELECT id,business_date FROM mbox.orders WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id
   AND table_session_id=NEW.id AND channel='staff_assisted' AND settlement_mode='table_tab' AND status='cancelled' LOOP
   basis:=mbox.carryover_tab_review_candidate(NEW.tenant_id,NEW.store_id,candidate.id);
   IF basis IS NOT NULL THEN
    INSERT INTO mbox.order_carryover_reviews(tenant_id,store_id,order_id,table_session_id,original_business_date,basis_snapshot)
    VALUES(NEW.tenant_id,NEW.store_id,candidate.id,NEW.id,candidate.business_date,basis) ON CONFLICT DO NOTHING;
   END IF;
 END LOOP;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION mbox.capture_closed_table_tab_reviews() FROM PUBLIC;
CREATE TRIGGER table_session_capture_tab_reviews AFTER UPDATE OF status ON mbox.table_sessions
 FOR EACH ROW EXECUTE FUNCTION mbox.capture_closed_table_tab_reviews();

-- Sole writer: explicit per-order employee decision, under session -> order locks.
CREATE FUNCTION mbox.confirm_carryover_tab_review(p_tenant uuid,p_store uuid,p_order uuid,p_employee uuid,p_amount bigint,p_basis jsonb,p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,mbox AS $$
DECLARE session_id uuid; basis jsonb;
BEGIN
 IF p_tenant IS DISTINCT FROM mbox.current_tenant_id() OR p_store IS DISTINCT FROM mbox.current_store_id()
 OR NOT EXISTS(SELECT 1 FROM mbox.employees WHERE tenant_id=p_tenant AND store_id=p_store AND id=p_employee AND status='active')
 OR NOT mbox.employee_has_effective_permission(p_tenant,p_store,p_employee,'payment.history.collect')
 OR NOT mbox.employee_has_effective_permission(p_tenant,p_store,p_employee,'reconciliation.view')
 THEN RAISE EXCEPTION '无权核对跨日挂账' USING ERRCODE='42501'; END IF;
 SELECT table_session_id INTO session_id FROM mbox.orders WHERE tenant_id=p_tenant AND store_id=p_store AND id=p_order;
 PERFORM 1 FROM mbox.table_sessions WHERE tenant_id=p_tenant AND store_id=p_store AND id=session_id FOR UPDATE;
 PERFORM 1 FROM mbox.orders WHERE tenant_id=p_tenant AND store_id=p_store AND id=p_order FOR UPDATE;
 basis:=mbox.carryover_tab_review_basis(p_tenant,p_store,p_order);
 IF basis IS NULL OR p_basis IS DISTINCT FROM basis OR p_amount IS NULL OR p_amount<0
 OR p_amount>(basis->>'maximumAmountMinor')::bigint OR p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 4 AND 500
 THEN RAISE EXCEPTION '挂账核对依据已变化或金额无效，请重新读取原单' USING ERRCODE='55000'; END IF;
 INSERT INTO mbox.order_carryover_reviews(tenant_id,store_id,order_id,table_session_id,original_business_date,basis_snapshot)
 VALUES(p_tenant,p_store,p_order,session_id,(basis->>'originalBusinessDate')::date,basis) ON CONFLICT DO NOTHING;
 INSERT INTO mbox.order_carryover_review_decisions(tenant_id,store_id,order_id,employee_id,amount_minor,reason,basis_snapshot)
 VALUES(p_tenant,p_store,p_order,p_employee,p_amount,btrim(p_reason),basis);
 IF p_amount>0 THEN
  INSERT INTO mbox.order_carryover_debts(tenant_id,store_id,order_id,table_session_id,original_business_date,
    receivable_minor,captured_receipts_minor,adjustment_minor_at_close,currency,eligibility,review_reason,closed_at)
  VALUES(p_tenant,p_store,p_order,session_id,(basis->>'originalBusinessDate')::date,p_amount,0,0,basis->>'currency','confirmed',
    '授权员工核对挂账：'||btrim(p_reason),(basis->>'closedAt')::timestamptz);
 END IF;
 RETURN jsonb_build_object('orderId',p_order,'amountMinor',p_amount,'employeeId',p_employee,'reason',btrim(p_reason));
END $$;
REVOKE ALL ON FUNCTION mbox.confirm_carryover_tab_review(uuid,uuid,uuid,uuid,bigint,jsonb,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mbox.confirm_carryover_tab_review(uuid,uuid,uuid,uuid,bigint,jsonb,text) TO mbox_runtime;
UPDATE mbox.normalized_schema_metadata SET schema_version='301',updated_at=clock_timestamp()
WHERE singleton=true AND schema_flavor='normalized-core-v1';
COMMIT;
