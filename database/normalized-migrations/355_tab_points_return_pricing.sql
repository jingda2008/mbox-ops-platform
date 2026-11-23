BEGIN;
-- The receivable can change only after the member's approved tender actually reserves the original points.
CREATE FUNCTION mbox.validate_tab_points_state() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='INSERT' THEN
   IF NEW.state<>'pending' OR NEW.confirmed_at IS NOT NULL THEN RAISE EXCEPTION '挂桌用分须先提交会员确认'; END IF;
   RETURN NEW;
 END IF;
 IF OLD.state<>'pending' OR NEW.state NOT IN ('applied','superseded') OR
    (NEW.state='applied') IS DISTINCT FROM (NEW.confirmed_at IS NOT NULL) THEN
   RAISE EXCEPTION '原挂桌用分状态已经处理';
 END IF;
 IF NEW.state='applied' AND NOT EXISTS(
   SELECT 1 FROM mbox.checkout_coupon_quotes q
   JOIN mbox.checkout_coupon_quote_seals seal ON (seal.tenant_id,seal.store_id,seal.quote_id)=(q.tenant_id,q.store_id,q.id)
   JOIN mbox.checkout_point_holds h ON (h.tenant_id,h.store_id,h.quote_id)=(q.tenant_id,q.store_id,q.id)
   WHERE (q.tenant_id,q.store_id,q.tab_request_id)=(NEW.tenant_id,NEW.store_id,NEW.id)
     AND q.customer_id=NEW.customer_id AND h.customer_id=NEW.customer_id AND h.status='held'
     AND h.points=NEW.points AND q.discount_minor=NEW.points::bigint*100
 ) THEN RAISE EXCEPTION '挂桌原单积分尚未占用'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER validate_tab_points_state BEFORE INSERT OR UPDATE ON mbox.tab_points_requests
 FOR EACH ROW EXECUTE FUNCTION mbox.validate_tab_points_state();

-- A return quotes each selected original unit's net cash share, even if its unit row predates the tender.
DO $$ DECLARE d text; needle text:='IF COALESCE(target.resolved_kind,target.kind)=''unpaid_stop'' THEN RETURN NULL; END IF;'; patched text; owner_name text;
BEGIN
 d:=pg_get_functiondef('mbox.quote_after_sales_price(uuid)'::regprocedure);
 patched:='IF mbox.tab_item_discount(target.tenant_id,target.store_id,original_item.id)>0 THEN
   SELECT count(*)::int,coalesce(sum(net/original_item.quantity + CASE WHEN unit.unit_index < mod(net,original_item.quantity) THEN 1 ELSE 0 END),0)
     INTO known_count,selected_amount
   FROM mbox.item_after_sales_case_units selected JOIN mbox.order_item_quantity_units unit ON unit.id=selected.unit_id
   CROSS JOIN LATERAL(SELECT original_item.total_amount_minor-mbox.tab_item_discount(target.tenant_id,target.store_id,original_item.id) net) share
   WHERE selected.case_id=p_case;
 ELSIF COALESCE(target.resolved_kind,target.kind)=''unpaid_stop'' THEN RETURN NULL; END IF;';
 IF position(needle IN d)=0 THEN RAISE EXCEPTION '缺少原退菜计价入口'; END IF;
 EXECUTE replace(d,needle,patched);
 SELECT pg_get_userbyid(proowner) INTO STRICT owner_name FROM pg_proc WHERE oid='mbox.prepare_after_sales_price(uuid)'::regprocedure;
 EXECUTE format('GRANT SELECT(tenant_id,store_id,tab_item_id,discount_minor,quote_id) ON mbox.checkout_coupon_quote_lines TO %I',owner_name);
 EXECUTE format('GRANT SELECT(tenant_id,store_id,quote_id) ON mbox.checkout_coupon_order_links TO %I',owner_name);
END $$;
UPDATE mbox.normalized_schema_metadata SET schema_version='355',updated_at=clock_timestamp() WHERE singleton;
COMMIT;
