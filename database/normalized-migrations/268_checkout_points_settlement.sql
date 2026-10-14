BEGIN;
ALTER TABLE mbox.loyalty_policy_versions ADD COLUMN cash_redemption_enabled boolean NOT NULL DEFAULT false,
 ADD CONSTRAINT cash_points_fixed_policy CHECK(NOT cash_redemption_enabled OR (policy_code='BASE' AND points_rounding_scope='order'));
CREATE FUNCTION mbox.guard_cash_points_policy() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF (OLD.status<>'draft' OR NEW.status<>'draft') AND NEW.cash_redemption_enabled IS DISTINCT FROM OLD.cash_redemption_enabled THEN RAISE EXCEPTION 'Approved points redemption policy is immutable'; END IF;
 RETURN NEW; END $$;
CREATE TRIGGER guard_cash_points_policy BEFORE UPDATE ON mbox.loyalty_policy_versions FOR EACH ROW EXECUTE FUNCTION mbox.guard_cash_points_policy();

ALTER TABLE mbox.checkout_coupon_quotes ADD COLUMN points_used integer NOT NULL DEFAULT 0 CHECK(points_used>=0),
 ADD COLUMN points_policy_id uuid,
 ADD CONSTRAINT checkout_points_quote_rule_fk FOREIGN KEY(tenant_id,store_id,points_policy_id) REFERENCES mbox.loyalty_policy_versions(tenant_id,store_id,id),
 ADD CONSTRAINT checkout_points_quote_value CHECK((points_used=0 AND points_policy_id IS NULL) OR (points_used>0 AND points_policy_id IS NOT NULL AND discount_minor=points_used::bigint*100));
DO $$ DECLARE target text;matches integer; BEGIN
 SELECT count(*),min(conname) INTO matches,target FROM pg_constraint WHERE conrelid='mbox.checkout_coupon_quote_lines'::regclass AND contype='c' AND pg_get_constraintdef(oid) LIKE '%benefit_id%';
 IF matches<>1 THEN RAISE EXCEPTION 'Expected one coupon line benefit constraint'; END IF;
 EXECUTE format('ALTER TABLE mbox.checkout_coupon_quote_lines DROP CONSTRAINT %I',target);
END $$;
CREATE FUNCTION mbox.validate_checkout_points_line() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE point_count integer;
BEGIN
 SELECT points_used INTO point_count FROM mbox.checkout_coupon_quotes WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id AND id=NEW.quote_id;
 IF (point_count>0 AND NEW.benefit_id IS NOT NULL) OR (point_count=0 AND NEW.benefit_id IS NULL AND NEW.discount_minor<>0) THEN RAISE EXCEPTION 'Points and coupons cannot be combined'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER validate_checkout_points_line BEFORE INSERT ON mbox.checkout_coupon_quote_lines FOR EACH ROW EXECUTE FUNCTION mbox.validate_checkout_points_line();
CREATE TABLE mbox.checkout_point_holds(
 tenant_id uuid NOT NULL,store_id uuid NOT NULL,quote_id uuid NOT NULL,membership_id uuid NOT NULL,customer_id uuid NOT NULL,
 points integer NOT NULL CHECK(points>0),restored_points integer NOT NULL DEFAULT 0 CHECK(restored_points>=0 AND restored_points<=points),
 status text NOT NULL DEFAULT 'held' CHECK(status IN('held','consumed','released')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,store_id,quote_id),
 FOREIGN KEY(tenant_id,store_id,quote_id) REFERENCES mbox.checkout_coupon_quotes(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,store_id,membership_id) REFERENCES mbox.customer_memberships(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,store_id,customer_id) REFERENCES mbox.customers(tenant_id,store_id,id)
);
CREATE TABLE mbox.checkout_point_lots(
 tenant_id uuid NOT NULL,store_id uuid NOT NULL,quote_id uuid NOT NULL,lot_id uuid NOT NULL,
 points integer NOT NULL CHECK(points>0),restored_points integer NOT NULL DEFAULT 0 CHECK(restored_points>=0 AND restored_points<=points),
 PRIMARY KEY(tenant_id,store_id,quote_id,lot_id),
 FOREIGN KEY(tenant_id,store_id,quote_id) REFERENCES mbox.checkout_point_holds(tenant_id,store_id,quote_id),
 FOREIGN KEY(tenant_id,store_id,lot_id) REFERENCES mbox.loyalty_point_lots(tenant_id,store_id,id)
);
CREATE TABLE mbox.checkout_point_restorations(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL,store_id uuid NOT NULL,quote_id uuid NOT NULL,
 source_key text NOT NULL,points integer NOT NULL CHECK(points>0),credited_points integer NOT NULL CHECK(credited_points>=0 AND credited_points<=points),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(tenant_id,store_id,quote_id,source_key),
 FOREIGN KEY(tenant_id,store_id,quote_id) REFERENCES mbox.checkout_point_holds(tenant_id,store_id,quote_id)
);
CREATE FUNCTION mbox.validate_checkout_points_hold() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='UPDATE' THEN
  IF ROW(NEW.tenant_id,NEW.store_id,NEW.quote_id,NEW.membership_id,NEW.customer_id,NEW.points) IS DISTINCT FROM ROW(OLD.tenant_id,OLD.store_id,OLD.quote_id,OLD.membership_id,OLD.customer_id,OLD.points)
    OR NEW.restored_points<OLD.restored_points OR (OLD.status='released' AND NEW IS DISTINCT FROM OLD) OR (OLD.status='consumed' AND NEW.status='held') THEN RAISE EXCEPTION 'Points hold facts cannot be rewritten'; END IF;
 ELSE
  IF NEW.status<>'held' OR NEW.restored_points<>0 OR NOT EXISTS(SELECT 1 FROM mbox.checkout_coupon_quotes q JOIN mbox.loyalty_accounts a ON a.tenant_id=q.tenant_id AND a.store_id=q.store_id AND a.membership_id=NEW.membership_id AND a.customer_id=NEW.customer_id WHERE q.tenant_id=NEW.tenant_id AND q.store_id=NEW.store_id AND q.id=NEW.quote_id AND q.points_used=NEW.points AND q.points_used>0 AND mbox.canonical_customer_id(q.tenant_id,q.store_id,q.customer_id)=mbox.canonical_customer_id(a.tenant_id,a.store_id,a.customer_id)) THEN RAISE EXCEPTION 'Points hold requires owned quote and account'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER validate_checkout_points_hold BEFORE INSERT OR UPDATE ON mbox.checkout_point_holds FOR EACH ROW EXECUTE FUNCTION mbox.validate_checkout_points_hold();
CREATE FUNCTION mbox.guard_checkout_point_lots() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF ROW(NEW.tenant_id,NEW.store_id,NEW.quote_id,NEW.lot_id,NEW.points) IS DISTINCT FROM ROW(OLD.tenant_id,OLD.store_id,OLD.quote_id,OLD.lot_id,OLD.points) OR NEW.restored_points<OLD.restored_points THEN RAISE EXCEPTION 'Original points allocations are immutable'; END IF;
 RETURN NEW; END $$;
CREATE TRIGGER guard_checkout_point_lots BEFORE UPDATE ON mbox.checkout_point_lots FOR EACH ROW EXECUTE FUNCTION mbox.guard_checkout_point_lots();
CREATE FUNCTION mbox.validate_checkout_points_allocations() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE q uuid;h mbox.checkout_point_holds;
BEGIN
 q:=NEW.quote_id;
 SELECT * INTO h FROM mbox.checkout_point_holds WHERE tenant_id=NEW.tenant_id AND store_id=NEW.store_id AND quote_id=q;
 IF h.points<>(SELECT COALESCE(sum(points),0) FROM mbox.checkout_point_lots WHERE tenant_id=h.tenant_id AND store_id=h.store_id AND quote_id=h.quote_id)
 OR h.restored_points<>(SELECT COALESCE(sum(restored_points),0) FROM mbox.checkout_point_lots WHERE tenant_id=h.tenant_id AND store_id=h.store_id AND quote_id=h.quote_id)
 OR EXISTS(SELECT 1 FROM mbox.checkout_point_lots a JOIN mbox.loyalty_point_lots l ON (l.tenant_id,l.store_id,l.id)=(a.tenant_id,a.store_id,a.lot_id) WHERE a.tenant_id=h.tenant_id AND a.store_id=h.store_id AND a.quote_id=h.quote_id AND l.membership_id<>h.membership_id) THEN RAISE EXCEPTION 'Points hold requires exact original lot allocations'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER checkout_points_hold_allocations AFTER INSERT OR UPDATE ON mbox.checkout_point_holds DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION mbox.validate_checkout_points_allocations();
CREATE CONSTRAINT TRIGGER checkout_points_lot_allocations AFTER INSERT OR UPDATE ON mbox.checkout_point_lots DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION mbox.validate_checkout_points_allocations();
DO $$ DECLARE name text; BEGIN
 FOREACH name IN ARRAY ARRAY['checkout_point_holds','checkout_point_lots','checkout_point_restorations'] LOOP
  EXECUTE format('ALTER TABLE mbox.%I ENABLE ROW LEVEL SECURITY',name);
  EXECUTE format('ALTER TABLE mbox.%I FORCE ROW LEVEL SECURITY',name);
  EXECUTE format('CREATE POLICY tenant_store_isolation ON mbox.%I USING(tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id()) WITH CHECK(tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id())',name);
  EXECUTE format('REVOKE ALL ON mbox.%I FROM PUBLIC,mbox_runtime',name);
  EXECUTE format('GRANT SELECT,INSERT ON mbox.%I TO mbox_runtime',name);
 END LOOP;
END $$;
GRANT UPDATE ON mbox.checkout_point_holds,mbox.checkout_point_lots TO mbox_runtime;
CREATE TRIGGER immutable_row BEFORE UPDATE OR DELETE ON mbox.checkout_point_restorations FOR EACH ROW EXECUTE FUNCTION mbox.reject_row_change();
CREATE FUNCTION mbox.order_fully_settled_by_points(p_tenant uuid,p_store uuid,p_order uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog,mbox AS $$
 SELECT EXISTS(SELECT 1 FROM mbox.orders o JOIN mbox.checkout_coupon_order_links l ON (l.tenant_id,l.store_id,l.order_id)=(o.tenant_id,o.store_id,o.id)
 JOIN mbox.checkout_coupon_quotes q ON (q.tenant_id,q.store_id,q.id)=(l.tenant_id,l.store_id,l.quote_id)
 JOIN mbox.checkout_point_holds h ON (h.tenant_id,h.store_id,h.quote_id)=(q.tenant_id,q.store_id,q.id)
 WHERE o.tenant_id=p_tenant AND o.store_id=p_store AND o.id=p_order AND o.total_amount_minor=0 AND q.payable_minor=0 AND q.points_used>0 AND h.points=q.points_used AND h.status IN('held','consumed') AND (h.status='consumed' OR h.restored_points=0))
$$;
DO $$ DECLARE original text;needle text:='AND receipt.succeeded_at IS NOT NULL AND receipt.amount_minor>0)'; BEGIN
 SELECT pg_get_functiondef('mbox.order_consumption_settled(uuid,uuid,uuid)'::regprocedure) INTO original;
 IF position(needle IN original)=0 THEN RAISE EXCEPTION 'Unexpected settlement definition'; END IF;
 original:=replace(original,'AND EXISTS(SELECT 1 FROM mbox.order_payment_facts receipt','AND (mbox.order_fully_settled_by_points(p_tenant,p_store,p_order) OR EXISTS(SELECT 1 FROM mbox.order_payment_facts receipt');
 EXECUTE replace(original,needle,needle||')');
END $$;
REVOKE ALL ON FUNCTION mbox.validate_checkout_points_line(),mbox.validate_checkout_points_hold(),mbox.validate_checkout_points_allocations(),mbox.order_fully_settled_by_points(uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mbox.order_fully_settled_by_points(uuid,uuid,uuid) TO mbox_runtime;
-- Retained components keep the existing original-single-price policy. Original
-- points cover retained value first; only excess original points are restored.
DO $$ DECLARE original text;needle text; BEGIN
 SELECT pg_get_functiondef('mbox.quote_after_sales_price(uuid)'::regprocedure) INTO original;
 needle:='IF EXISTS(SELECT 1 FROM mbox.checkout_coupon_order_links WHERE tenant_id=target.tenant_id AND store_id=target.store_id AND order_id=target.order_id) THEN RETURN NULL; END IF;';
 IF position(needle IN original)=0 THEN RAISE EXCEPTION 'Unexpected bundle price authority'; END IF;
 original:=replace(original,needle,'IF EXISTS(SELECT 1 FROM mbox.checkout_coupon_order_links l JOIN mbox.checkout_coupon_quotes q ON (q.tenant_id,q.store_id,q.id)=(l.tenant_id,l.store_id,l.quote_id) WHERE l.tenant_id=target.tenant_id AND l.store_id=target.store_id AND l.order_id=target.order_id AND q.points_used=0) THEN RETURN NULL; END IF;');
 needle:='quote_policy:=''broken_bundle'';delta:=retained_amount-root_effective;';
 IF position(needle IN original)=0 THEN RAISE EXCEPTION 'Unexpected retained bundle price formula'; END IF;
 original:=replace(original,needle,'IF EXISTS(SELECT 1 FROM mbox.checkout_coupon_order_links l JOIN mbox.checkout_point_holds h ON (h.tenant_id,h.store_id,h.quote_id)=(l.tenant_id,l.store_id,l.quote_id) WHERE l.tenant_id=target.tenant_id AND l.store_id=target.store_id AND l.order_id=target.order_id AND h.status=''consumed'') THEN retained_amount:=GREATEST(0,retained_amount-root_item.discount_amount_minor); END IF;
  quote_policy:=''broken_bundle'';delta:=retained_amount-root_effective;');
 EXECUTE original;
END $$;
CREATE FUNCTION mbox.points_stop_approved(p_tenant uuid,p_store uuid,p_case uuid,p_employee uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog,mbox AS $$
 SELECT EXISTS(SELECT 1 FROM mbox.item_after_sales_cases c
 WHERE c.tenant_id=p_tenant AND c.store_id=p_store AND c.id=p_case AND c.status IN('approved','completed') AND c.amount_minor=0
 AND c.decided_by_employee_id=p_employee AND c.requested_by_employee_id<>p_employee
 AND mbox.order_fully_settled_by_points(p_tenant,p_store,c.order_id)
 AND mbox.employee_has_effective_permission(p_tenant,p_store,p_employee,'refund.approve')
 AND EXISTS(SELECT 1 FROM mbox.employee_roles er JOIN mbox.roles role ON (role.tenant_id,role.store_id,role.id)=(er.tenant_id,er.store_id,er.role_id)
 JOIN mbox.role_approval_limits lim ON (lim.tenant_id,lim.store_id,lim.role_id)=(er.tenant_id,er.store_id,er.role_id)
 WHERE er.tenant_id=p_tenant AND er.store_id=p_store AND er.employee_id=p_employee AND er.starts_at<=clock_timestamp() AND (er.ends_at IS NULL OR er.ends_at>clock_timestamp()) AND role.status='active'
 AND lim.enabled AND lim.approval_code='refund.approve' AND lim.currency='CNY' AND lim.amount_minor >= (
 SELECT COALESCE(ceil(CASE WHEN bool_or(i.parent_order_item_id IS NOT NULL) THEN max((SELECT root.discount_amount_minor FROM mbox.order_items root WHERE (root.tenant_id,root.store_id,root.id)=(i.tenant_id,i.store_id,i.parent_order_item_id))) ELSE sum(i.discount_amount_minor::numeric/i.quantity) END),0)
 FROM mbox.item_after_sales_case_units s JOIN mbox.order_item_quantity_units u ON (u.tenant_id,u.store_id,u.id)=(s.tenant_id,s.store_id,s.unit_id)
 JOIN mbox.order_items i ON (i.tenant_id,i.store_id,i.id)=(u.tenant_id,u.store_id,u.order_item_id)
 WHERE s.tenant_id=p_tenant AND s.store_id=p_store AND s.case_id=p_case)))
$$;
DO $$ DECLARE original text;needle text:='IF target_case.status=''approved'' AND ('; BEGIN
 SELECT pg_get_functiondef('mbox.guard_quantity_receivable_adjustment()'::regprocedure) INTO original;
 IF position(needle IN original)=0 THEN RAISE EXCEPTION 'Unexpected quantity adjustment authority definition'; END IF;
 original:=replace(original,needle,'IF mbox.order_fully_settled_by_points(NEW.tenant_id,NEW.store_id,NEW.order_id) AND NOT mbox.points_stop_approved(NEW.tenant_id,NEW.store_id,NEW.case_id,NEW.created_by_employee_id) THEN RAISE EXCEPTION ''Points stop requires independent financial approval''; END IF;
  IF target_case.status=''approved'' AND NOT mbox.points_stop_approved(NEW.tenant_id,NEW.store_id,NEW.case_id,NEW.created_by_employee_id) AND (');
 EXECUTE original;
END $$;
REVOKE ALL ON FUNCTION mbox.points_stop_approved(uuid,uuid,uuid,uuid),mbox.guard_checkout_point_lots(),mbox.guard_cash_points_policy() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mbox.points_stop_approved(uuid,uuid,uuid,uuid) TO mbox_runtime;
UPDATE mbox.normalized_schema_metadata SET schema_version='268',updated_at=clock_timestamp() WHERE singleton=true;
COMMIT;
