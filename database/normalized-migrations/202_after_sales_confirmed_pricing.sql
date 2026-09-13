BEGIN;
-- Confirmed store policy: refund only captured money, and reprice retained
-- components of a broken bundle at the single prices saved on the original order.
-- Original invoice and unit prices remain immutable.
-- A confirmed unpaid resolution keeps the same unpaid authority as an order
-- originally known to be unpaid. Paid refunds still require another employee.
DO $unpaid_identity$ DECLARE original_name text; BEGIN
 SELECT conname INTO STRICT original_name FROM pg_constraint WHERE conrelid='mbox.item_after_sales_cases'::regclass AND contype='c' AND pg_get_constraintdef(oid) LIKE '%decided_by_employee_id%';
 EXECUTE format('ALTER TABLE mbox.item_after_sales_cases DROP CONSTRAINT %I',original_name);
END $unpaid_identity$;
ALTER TABLE mbox.item_after_sales_cases ADD CONSTRAINT item_after_sales_decision_identity
 CHECK(decided_by_employee_id IS NULL OR decided_by_employee_id<>requested_by_employee_id OR COALESCE(resolved_kind,kind)='unpaid_stop');
CREATE TABLE mbox.item_after_sales_price_resolutions (
 case_id uuid PRIMARY KEY,tenant_id uuid NOT NULL,store_id uuid NOT NULL,order_id uuid NOT NULL,
 order_item_id uuid NOT NULL,refund_order_item_id uuid NOT NULL,
 policy text NOT NULL CHECK(policy IN ('captured_payment','broken_bundle')),
 refund_amount_minor bigint NOT NULL CHECK(refund_amount_minor>=0),
 receivable_delta_minor bigint NOT NULL,
 selected_quantity integer NOT NULL CHECK(selected_quantity>0),
 snapshot jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(tenant_id,store_id,case_id) REFERENCES mbox.item_after_sales_cases(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,store_id,order_id) REFERENCES mbox.orders(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,store_id,order_item_id) REFERENCES mbox.order_items(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,store_id,refund_order_item_id) REFERENCES mbox.order_items(tenant_id,store_id,id)
);
CREATE INDEX item_after_sales_price_order_idx ON mbox.item_after_sales_price_resolutions(tenant_id,store_id,order_id);
CREATE INDEX item_after_sales_price_parent_idx ON mbox.item_after_sales_price_resolutions(tenant_id,store_id,refund_order_item_id);
ALTER TABLE mbox.item_after_sales_price_resolutions ENABLE ROW LEVEL SECURITY;
ALTER TABLE mbox.item_after_sales_price_resolutions FORCE ROW LEVEL SECURITY;
CREATE POLICY price_resolution_scope ON mbox.item_after_sales_price_resolutions
 USING(tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id())
 WITH CHECK(tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id());
GRANT SELECT ON mbox.item_after_sales_price_resolutions TO mbox_runtime;
CREATE VIEW mbox.item_receivable_adjustment_facts WITH(security_invoker=true) AS
 SELECT id,tenant_id,store_id,case_id,order_id,order_item_id,amount_minor,quantity,business_date,created_by_employee_id,created_at
 FROM mbox.item_receivable_adjustments
 UNION ALL
 SELECT price.case_id,price.tenant_id,price.store_id,price.case_id,price.order_id,price.refund_order_item_id,
  -price.receivable_delta_minor,price.selected_quantity,target.business_date,target.decided_by_employee_id,price.created_at
 FROM mbox.item_after_sales_price_resolutions price JOIN mbox.item_after_sales_cases target
 ON target.tenant_id=price.tenant_id AND target.store_id=price.store_id AND target.id=price.case_id
 WHERE target.status IN('approved','completed');
GRANT SELECT ON mbox.item_receivable_adjustment_facts TO mbox_runtime;
CREATE OR REPLACE FUNCTION mbox.order_receivable_amount(p_tenant uuid,p_store uuid,p_order uuid) RETURNS bigint LANGUAGE sql STABLE AS $$
 SELECT original.total_amount_minor-COALESCE((SELECT sum(adjustment.amount_minor) FROM mbox.item_receivable_adjustment_facts adjustment
 WHERE adjustment.tenant_id=original.tenant_id AND adjustment.store_id=original.store_id AND adjustment.order_id=original.id),0)::bigint
 FROM mbox.orders original WHERE original.tenant_id=p_tenant AND original.store_id=p_store AND original.id=p_order
 AND original.tenant_id=mbox.current_tenant_id() AND original.store_id=mbox.current_store_id()
$$;
CREATE FUNCTION mbox.quote_after_sales_price(p_case uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path=pg_catalog,mbox AS $$
DECLARE target mbox.item_after_sales_cases; original_item mbox.order_items; root_item mbox.order_items;
 selected_count integer; selected_amount bigint; known_count integer; captured bigint; reserved bigint; available bigint;
 effective bigint; root_effective bigint; retained_amount bigint:=0; remaining_count integer; single_price bigint; part record;
 quote_policy text; refund_amount bigint; delta bigint; components jsonb:='[]'::jsonb;
BEGIN
 SELECT * INTO target FROM mbox.item_after_sales_cases WHERE tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id() AND id=p_case;
 IF NOT FOUND OR target.status<>'requested' THEN RETURN NULL; END IF;
 SELECT original.* INTO original_item FROM mbox.order_items original JOIN mbox.item_after_sales_case_units selected
 ON selected.tenant_id=original.tenant_id AND selected.store_id=original.store_id
 JOIN mbox.order_item_quantity_units unit ON unit.tenant_id=selected.tenant_id AND unit.store_id=selected.store_id AND unit.id=selected.unit_id AND unit.order_item_id=original.id
 WHERE selected.tenant_id=target.tenant_id AND selected.store_id=target.store_id AND selected.case_id=p_case LIMIT 1;
 IF NOT FOUND OR EXISTS(SELECT 1 FROM mbox.item_after_sales_case_units selected JOIN mbox.order_item_quantity_units unit ON unit.tenant_id=selected.tenant_id AND unit.store_id=selected.store_id AND unit.id=selected.unit_id
 WHERE selected.tenant_id=target.tenant_id AND selected.store_id=target.store_id AND selected.case_id=p_case AND unit.order_item_id<>original_item.id) THEN RETURN NULL; END IF;
 IF EXISTS(SELECT 1 FROM mbox.order_payment_facts payment WHERE payment.tenant_id=target.tenant_id AND payment.store_id=target.store_id AND payment.order_id=target.order_id AND payment.status NOT IN('succeeded','partially_refunded','refunded','failed','closed')) THEN RETURN NULL; END IF;
 SELECT count(*)::integer,count(unit.original_amount_minor)::integer,sum(unit.original_amount_minor)::bigint INTO selected_count,known_count,selected_amount
 FROM mbox.item_after_sales_case_units selected JOIN mbox.order_item_quantity_units unit ON unit.tenant_id=selected.tenant_id AND unit.store_id=selected.store_id AND unit.id=selected.unit_id
 WHERE selected.tenant_id=target.tenant_id AND selected.store_id=target.store_id AND selected.case_id=p_case;
 SELECT COALESCE(sum(amount_minor),0) INTO captured FROM mbox.order_payment_facts WHERE tenant_id=target.tenant_id AND store_id=target.store_id AND order_id=target.order_id AND status IN('succeeded','partially_refunded','refunded');
 SELECT COALESCE(sum(refund.amount_minor),0) INTO reserved FROM mbox.order_refund_facts refund
 WHERE refund.tenant_id=target.tenant_id AND refund.store_id=target.store_id AND refund.order_id=target.order_id
 AND NOT EXISTS(SELECT 1 FROM mbox.item_after_sales_case_refunds own WHERE own.tenant_id=refund.tenant_id AND own.store_id=refund.store_id AND own.case_id=p_case AND own.refund_id=refund.id)
 AND (refund.status IN('requested','approved','processing','succeeded') OR refund.status='failed'
  AND NOT EXISTS(SELECT 1 FROM mbox.item_after_sales_refund_retries newer WHERE newer.tenant_id=refund.tenant_id AND newer.store_id=refund.store_id AND newer.previous_refund_id=refund.id)
  AND EXISTS(SELECT 1 FROM mbox.item_after_sales_case_refunds link JOIN mbox.item_after_sales_cases pending ON pending.tenant_id=link.tenant_id AND pending.store_id=link.store_id AND pending.id=link.case_id WHERE link.tenant_id=refund.tenant_id AND link.store_id=refund.store_id AND link.refund_id=refund.id AND pending.status='approved'));
 IF captured=0 AND COALESCE(target.resolved_kind,target.kind)<>'unpaid_stop' AND NOT (target.kind='payment_review' AND original_item.parent_order_item_id IS NOT NULL) THEN RETURN NULL; END IF;
 available:=greatest(0,captured-reserved);effective:=mbox.order_receivable_amount(target.tenant_id,target.store_id,target.order_id);
 IF original_item.parent_order_item_id IS NULL THEN
  IF COALESCE(target.resolved_kind,target.kind)='unpaid_stop' THEN RETURN NULL; END IF;
  IF known_count<>selected_count THEN
   IF selected_count<>original_item.quantity THEN RETURN NULL; END IF;
   selected_amount:=original_item.total_amount_minor;
  END IF;
  root_item:=original_item;quote_policy:='captured_payment';refund_amount:=least(selected_amount,available);delta:=-selected_amount;
 ELSE
  -- Coupon/points disposal is a separate original-order policy. Until resolved,
  -- these orders stay paused; never return a coupon while retaining its discount.
  IF EXISTS(SELECT 1 FROM mbox.checkout_coupon_order_links WHERE tenant_id=target.tenant_id AND store_id=target.store_id AND order_id=target.order_id) THEN RETURN NULL; END IF;
  SELECT * INTO STRICT root_item FROM mbox.order_items WHERE tenant_id=target.tenant_id AND store_id=target.store_id AND id=original_item.parent_order_item_id;
  -- A merged multi-bundle line does not preserve which component belongs to
  -- which original package; do not revoke discounts on intact packages.
  IF root_item.quantity<>1 THEN RETURN NULL; END IF;
  root_effective:=root_item.total_amount_minor+COALESCE((SELECT sum(price.receivable_delta_minor) FROM mbox.item_after_sales_price_resolutions price JOIN mbox.item_after_sales_cases accepted ON accepted.tenant_id=price.tenant_id AND accepted.store_id=price.store_id AND accepted.id=price.case_id
    WHERE price.tenant_id=target.tenant_id AND price.store_id=target.store_id AND price.refund_order_item_id=root_item.id AND accepted.status IN('approved','completed')),0);
  FOR part IN SELECT * FROM mbox.order_items WHERE tenant_id=target.tenant_id AND store_id=target.store_id AND parent_order_item_id=root_item.id ORDER BY id LOOP
   SELECT part.quantity-count(*)::integer INTO remaining_count FROM mbox.order_item_quantity_units unit WHERE unit.tenant_id=target.tenant_id AND unit.store_id=target.store_id AND unit.order_item_id=part.id
    AND (unit.operationally_stopped OR EXISTS(SELECT 1 FROM mbox.item_after_sales_case_units selected JOIN mbox.item_after_sales_cases accepted ON accepted.tenant_id=selected.tenant_id AND accepted.store_id=selected.store_id AND accepted.id=selected.case_id
      WHERE selected.tenant_id=unit.tenant_id AND selected.store_id=unit.store_id AND selected.unit_id=unit.id AND (accepted.id=p_case OR accepted.status IN('approved','completed'))));
   IF remaining_count<0 OR part.status='cancelled' AND remaining_count>0 THEN RETURN NULL; END IF;
   single_price:=NULL;
   IF remaining_count>0 THEN
    IF COALESCE(part.product_snapshot->>'singlePriceReferenceMinor','')!~'^[0-9]{1,15}$' THEN RETURN NULL; END IF;
    single_price:=(part.product_snapshot->>'singlePriceReferenceMinor')::bigint;
    retained_amount:=retained_amount+remaining_count*single_price;
   END IF;
   components:=components||jsonb_build_array(jsonb_build_object('itemId',part.id,'retainedQuantity',remaining_count,'originalSinglePriceMinor',single_price));
  END LOOP;
  quote_policy:='broken_bundle';delta:=retained_amount-root_effective;
  refund_amount:=greatest(0,available-(effective+delta));
 END IF;
 IF effective+delta<0 OR abs(delta)>9007199254740991 OR refund_amount>9007199254740991 THEN RETURN NULL; END IF;
 RETURN jsonb_build_object('policy',quote_policy,'orderId',target.order_id,'orderItemId',original_item.id,'refundOrderItemId',root_item.id,
  'selectedOriginalMinor',selected_amount,'otherEffectiveChargesMinor',CASE WHEN root_effective IS NULL THEN NULL ELSE effective-root_effective END,
  'selectedQuantity',selected_count,'refundAmountMinor',refund_amount,'receivableDeltaMinor',delta,'originalEffectiveAmountMinor',effective,
  'effectiveAmountMinor',effective+delta,'availablePaidMinor',available,'components',components);
END $$;
REVOKE ALL ON FUNCTION mbox.quote_after_sales_price(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mbox.quote_after_sales_price(uuid) TO mbox_runtime;
CREATE FUNCTION mbox.prepare_after_sales_price(p_case uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,mbox AS $$
DECLARE result jsonb; original mbox.item_after_sales_cases;
BEGIN
 SELECT * INTO original FROM mbox.item_after_sales_cases WHERE tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id() AND id=p_case;
 IF NOT FOUND THEN RAISE EXCEPTION 'original case missing' USING ERRCODE='23514'; END IF;
 PERFORM 1 FROM mbox.orders WHERE tenant_id=original.tenant_id AND store_id=original.store_id AND id=original.order_id FOR UPDATE;
 SELECT snapshot INTO result FROM mbox.item_after_sales_price_resolutions WHERE tenant_id=original.tenant_id AND store_id=original.store_id AND case_id=p_case;
 IF FOUND THEN RETURN result; END IF;
 result:=mbox.quote_after_sales_price(p_case);IF result IS NULL THEN RETURN NULL; END IF;
 INSERT INTO mbox.item_after_sales_price_resolutions(case_id,tenant_id,store_id,order_id,order_item_id,refund_order_item_id,policy,refund_amount_minor,receivable_delta_minor,selected_quantity,snapshot)
 VALUES(p_case,original.tenant_id,original.store_id,original.order_id,(result->>'orderItemId')::uuid,(result->>'refundOrderItemId')::uuid,result->>'policy',(result->>'refundAmountMinor')::bigint,(result->>'receivableDeltaMinor')::bigint,(result->>'selectedQuantity')::integer,result);
 UPDATE mbox.item_after_sales_cases SET amount_minor=(result->>'refundAmountMinor')::bigint WHERE tenant_id=original.tenant_id AND store_id=original.store_id AND id=p_case;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION mbox.prepare_after_sales_price(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mbox.prepare_after_sales_price(uuid) TO mbox_runtime;
CREATE FUNCTION mbox.guard_after_sales_price_approval() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,mbox AS $$
DECLARE original jsonb; current_quote jsonb;
BEGIN
 IF NEW.status='approved' AND OLD.status='requested' THEN
  SELECT snapshot INTO original FROM mbox.item_after_sales_price_resolutions WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id AND case_id=NEW.id;
  IF FOUND THEN
   current_quote:=mbox.quote_after_sales_price(NEW.id);
   IF (current_quote-ARRAY['originalEffectiveAmountMinor','effectiveAmountMinor','availablePaidMinor','otherEffectiveChargesMinor']) IS DISTINCT FROM (original-ARRAY['originalEffectiveAmountMinor','effectiveAmountMinor','availablePaidMinor','otherEffectiveChargesMinor']) OR NEW.amount_minor<>(original->>'refundAmountMinor')::bigint THEN
    RAISE EXCEPTION 'original pricing changed; revise the paused request before approval' USING ERRCODE='23514';
   END IF;
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER quantity_price_approval BEFORE UPDATE ON mbox.item_after_sales_cases FOR EACH ROW EXECUTE FUNCTION mbox.guard_after_sales_price_approval();
-- Keep all prior source constraints; a bundle refund is allocated only to its
-- persisted paid parent, never to the zero-price operational child.
DO $price_refund_source$ DECLARE definition text; needle text; BEGIN
 definition:=pg_get_functiondef('mbox.guard_quantity_refund_order()'::regprocedure);
 needle:='AND unit.order_item_id = allocation.order_item_id';
 -- pg_get_functiondef retains the original PL/pgSQL body formatting.
 needle:='AND unit.order_item_id=allocation.order_item_id';
 IF position(needle IN definition)=0 THEN RAISE EXCEPTION 'quantity refund source changed'; END IF;
 EXECUTE replace(definition,needle,'AND (unit.order_item_id=allocation.order_item_id OR EXISTS(SELECT 1 FROM mbox.item_after_sales_price_resolutions price WHERE price.tenant_id=target.tenant_id AND price.store_id=target.store_id AND price.case_id=target.id AND price.order_item_id=unit.order_item_id AND price.refund_order_item_id=allocation.order_item_id))');
END $price_refund_source$;
-- Existing read models use the same effective charges, while the original
-- immutable unpaid-waiver table keeps its original write constraints.
DO $read_models$ DECLARE view_row record; definition text; BEGIN
 FOR view_row IN SELECT c.oid,n.nspname,c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='mbox' AND c.relkind='v' AND c.relname<>'item_receivable_adjustment_facts' LOOP
  definition:=pg_get_viewdef(view_row.oid,true);
  IF position('mbox.item_receivable_adjustments' IN definition)>0 THEN
   EXECUTE format('CREATE OR REPLACE VIEW %I.%I WITH(security_invoker=true) AS %s',view_row.nspname,view_row.relname,replace(definition,'mbox.item_receivable_adjustments','mbox.item_receivable_adjustment_facts'));
  END IF;
 END LOOP;
END $read_models$;
DO $price_completion$ DECLARE definition text; BEGIN
 definition:=pg_get_functiondef('mbox.protect_quantity_case_identity()'::regprocedure);
 IF position('mbox.item_receivable_adjustments' IN definition)=0 THEN RAISE EXCEPTION 'quantity completion source changed'; END IF;
 EXECUTE replace(definition,'mbox.item_receivable_adjustments','mbox.item_receivable_adjustment_facts');
END $price_completion$;
COMMIT;
