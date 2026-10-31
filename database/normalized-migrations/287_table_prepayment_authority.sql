BEGIN;
CREATE TABLE mbox.table_prepayment_revocations (
 tenant_id uuid NOT NULL,store_id uuid NOT NULL,payment_id uuid NOT NULL,customer_id uuid NOT NULL,
 reason text NOT NULL CHECK(length(trim(reason)) BETWEEN 2 AND 500),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,store_id,payment_id),
 FOREIGN KEY(tenant_id,store_id,payment_id) REFERENCES mbox.payments(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,store_id,customer_id) REFERENCES mbox.customers(tenant_id,store_id,id)
);
ALTER TABLE mbox.table_prepayment_revocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE mbox.table_prepayment_revocations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_store_isolation ON mbox.table_prepayment_revocations USING(tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id()) WITH CHECK(tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id());
GRANT SELECT,INSERT ON mbox.table_prepayment_revocations TO mbox_runtime;
CREATE TRIGGER immutable_revocation BEFORE UPDATE OR DELETE ON mbox.table_prepayment_revocations FOR EACH ROW EXECUTE FUNCTION mbox.reject_row_change();
CREATE FUNCTION mbox.guard_prepayment_revocation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE session_id uuid;owner_id uuid;
BEGIN
 SELECT prepaid_table_session_id INTO session_id FROM mbox.payments WHERE (tenant_id,store_id,id)=(NEW.tenant_id,NEW.store_id,NEW.payment_id);
 PERFORM id FROM mbox.table_sessions WHERE (tenant_id,store_id,id)=(NEW.tenant_id,NEW.store_id,session_id) FOR UPDATE;
 SELECT prepaid_customer_id INTO owner_id FROM mbox.payments WHERE (tenant_id,store_id,id)=(NEW.tenant_id,NEW.store_id,NEW.payment_id) FOR UPDATE;
 IF owner_id IS DISTINCT FROM NEW.customer_id THEN RAISE EXCEPTION 'only original payer can revoke shared prepayment' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guard_prepayment_revocation BEFORE INSERT ON mbox.table_prepayment_revocations FOR EACH ROW EXECUTE FUNCTION mbox.guard_prepayment_revocation();
DO $$ DECLARE definition text; BEGIN
 definition:=pg_get_functiondef('mbox.guard_prepayment_spend()'::regprocedure);
 definition:=replace(definition,'OR p.provider_snapshot->>''sharedTableConsent'' IS DISTINCT FROM ''v1''','OR EXISTS(SELECT 1 FROM mbox.table_prepayment_revocations revoked WHERE (revoked.tenant_id,revoked.store_id,revoked.payment_id)=(p.tenant_id,p.store_id,p.id)) OR p.provider_snapshot->>''sharedTableConsent'' IS DISTINCT FROM ''v1''');
 EXECUTE definition;
END $$;
CREATE FUNCTION mbox.order_fully_settled_by_checkout_quote(t uuid,s uuid,o uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT EXISTS(SELECT 1 FROM mbox.orders ordering
 JOIN mbox.checkout_coupon_order_links link ON(link.tenant_id,link.store_id,link.order_id)=(ordering.tenant_id,ordering.store_id,ordering.id)
 JOIN mbox.checkout_coupon_quotes quote ON(quote.tenant_id,quote.store_id,quote.id)=(link.tenant_id,link.store_id,link.quote_id)
 WHERE (ordering.tenant_id,ordering.store_id,ordering.id)=(t,s,o) AND ordering.total_amount_minor=0 AND quote.payable_minor=0
 AND (quote.points_used=0 OR mbox.order_fully_settled_by_points(t,s,o)))
$$;
DO $$ DECLARE definition text; BEGIN
 definition:=pg_get_functiondef('mbox.order_consumption_settled(uuid,uuid,uuid)'::regprocedure);
 definition:=replace(definition,'mbox.order_fully_settled_by_points(p_tenant,p_store,p_order)','mbox.order_fully_settled_by_checkout_quote(p_tenant,p_store,p_order)');EXECUTE definition;
END $$;
REVOKE ALL ON FUNCTION mbox.guard_prepayment_revocation(),mbox.order_fully_settled_by_checkout_quote(uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mbox.order_fully_settled_by_checkout_quote(uuid,uuid,uuid) TO mbox_runtime;
UPDATE mbox.normalized_schema_metadata SET schema_version='287',updated_at=clock_timestamp() WHERE singleton=true;
COMMIT;
