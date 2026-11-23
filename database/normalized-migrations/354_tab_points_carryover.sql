BEGIN;
DO $$ DECLARE d text; BEGIN
 d:=pg_get_functiondef('mbox.carryover_payment_status(uuid,uuid,uuid)'::regprocedure);
 EXECUTE replace(d,'>=d.receivable_minor','>=mbox.order_financial_receivable_amount(p_tenant,p_store,p_order)');
 d:=pg_get_functiondef('mbox.allow_carryover_order_projection(jsonb,jsonb,uuid)'::regprocedure);
 EXECUTE replace(d,' -- A separately approved refund','   IF new_row->>''payment_status''=''paid'' AND mbox.order_collection_due_amount(tenant,store,target)=0
     AND mbox.carryover_collection_eligibility(tenant,store,target)=''confirmed''
     AND EXISTS(SELECT 1 FROM mbox.tab_points_requests b JOIN mbox.checkout_coupon_quotes q ON q.tab_request_id=b.id
       JOIN mbox.checkout_coupon_quote_seals seal ON seal.quote_id=q.id JOIN mbox.checkout_point_holds h ON h.quote_id=q.id AND h.customer_id=b.customer_id JOIN mbox.checkout_coupon_order_links l ON l.quote_id=q.id AND l.order_id=b.order_id
       WHERE (b.tenant_id,b.store_id,b.order_id)=(tenant,store,target) AND b.state=''applied'' AND b.confirmed_at IS NOT NULL
       AND h.status IN(''held'',''consumed'') AND h.restored_points=0 AND h.points=b.points)
     AND NOT EXISTS(SELECT 1 FROM mbox.order_payment_facts f JOIN mbox.payments p ON p.id=f.id
       WHERE f.order_id=target AND p.succeeded_at IS NOT NULL AND NOT EXISTS(SELECT 1 FROM mbox.reconciliation_entries e WHERE e.payment_id=p.id
       AND e.amount_minor=p.amount_minor AND e.currency=p.currency AND e.entry_type=''payment''))
     THEN RETURN true; END IF;
 -- A separately approved refund');
END $$;
DO $$ DECLARE owner_name text; BEGIN
 SELECT pg_get_userbyid(proowner) INTO STRICT owner_name FROM pg_proc WHERE oid='mbox.prepare_after_sales_price(uuid)'::regprocedure;
 EXECUTE format('GRANT SELECT(tenant_id,store_id,order_id,state,points,confirmed_at) ON mbox.tab_points_requests TO %I',owner_name);
 IF position('tab_points_requests' IN pg_get_functiondef('mbox.allow_carryover_order_projection(jsonb,jsonb,uuid)'::regprocedure))=0 THEN
   RAISE EXCEPTION 'Missing reviewed carryover points projection'; END IF;
END $$;
UPDATE mbox.normalized_schema_metadata SET schema_version='354',updated_at=clock_timestamp() WHERE singleton;
COMMIT;
