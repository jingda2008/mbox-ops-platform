BEGIN;
CREATE TABLE mbox.channel_price_quotes (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL,store_id uuid NOT NULL,
 visit_id uuid NOT NULL,table_session_id uuid NOT NULL,actor_ref text NOT NULL,customer_id uuid,
 channel text NOT NULL CHECK(channel IN('guest_qr','staff_assisted')),
 snapshot jsonb NOT NULL CHECK(jsonb_typeof(snapshot)='object'),
 fingerprint char(64) NOT NULL,expires_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,store_id,visit_id) REFERENCES mbox.channel_visits(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,store_id,table_session_id) REFERENCES mbox.table_sessions(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,store_id,customer_id) REFERENCES mbox.customers(tenant_id,store_id,id)
);
CREATE TABLE mbox.channel_price_applications (
 tenant_id uuid NOT NULL,store_id uuid NOT NULL,quote_id uuid NOT NULL,activation_id uuid NOT NULL,
 order_id uuid NOT NULL,amount_minor bigint NOT NULL CHECK(amount_minor>0),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,store_id,quote_id,activation_id),
 UNIQUE(tenant_id,store_id,order_id,activation_id),
 FOREIGN KEY(tenant_id,store_id,quote_id) REFERENCES mbox.channel_price_quotes(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,store_id,activation_id) REFERENCES mbox.channel_activations(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,store_id,order_id) REFERENCES mbox.orders(tenant_id,store_id,id)
);
CREATE TABLE mbox.channel_price_releases (
 tenant_id uuid NOT NULL,store_id uuid NOT NULL,quote_id uuid NOT NULL,activation_id uuid NOT NULL,
 order_id uuid NOT NULL,reason text NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,store_id,quote_id,activation_id),
 FOREIGN KEY(tenant_id,store_id,quote_id,activation_id) REFERENCES mbox.channel_price_applications(tenant_id,store_id,quote_id,activation_id)
);
ALTER TABLE mbox.pricing_authorizations ADD COLUMN channel_quote_id uuid,
 ADD CONSTRAINT pricing_channel_quote_fk FOREIGN KEY(tenant_id,store_id,channel_quote_id) REFERENCES mbox.channel_price_quotes(tenant_id,store_id,id);
ALTER TABLE mbox.pricing_authorizations DROP CONSTRAINT pricing_authorizations_source_type_check;
ALTER TABLE mbox.pricing_authorizations ADD CONSTRAINT pricing_authorizations_source_type_check CHECK(source_type IN('employee','benefit','checkout_quote','channel_quote'));
ALTER TABLE mbox.pricing_authorizations DROP CONSTRAINT pricing_authorizations_source_integrity;
ALTER TABLE mbox.pricing_authorizations ADD CONSTRAINT pricing_authorizations_source_integrity CHECK(
 (source_type='employee' AND authorized_by_employee_id IS NOT NULL AND capability IN('order.discount','order.gift') AND role_approval_limit_id=source_id AND benefit_id IS NULL AND checkout_quote_id IS NULL AND channel_quote_id IS NULL)
 OR(source_type='benefit' AND capability IS NULL AND benefit_id=source_id AND role_approval_limit_id IS NULL AND checkout_quote_id IS NULL AND channel_quote_id IS NULL)
 OR(source_type='checkout_quote' AND capability IS NULL AND authorized_by_employee_id IS NULL AND benefit_id IS NULL AND role_approval_limit_id IS NULL AND checkout_quote_id IS NOT NULL AND checkout_quote_id=source_id AND channel_quote_id IS NULL AND kind='discount')
 OR(source_type='channel_quote' AND capability IS NULL AND authorized_by_employee_id IS NULL AND benefit_id IS NULL AND role_approval_limit_id IS NULL AND checkout_quote_id IS NULL AND channel_quote_id IS NOT NULL AND channel_quote_id=source_id AND kind='discount')
);
CREATE UNIQUE INDEX channel_price_quote_once ON mbox.pricing_authorizations(tenant_id,store_id,channel_quote_id) WHERE channel_quote_id IS NOT NULL;
DO $$ DECLARE n text; BEGIN
 FOREACH n IN ARRAY ARRAY['channel_price_quotes','channel_price_applications','channel_price_releases'] LOOP
  EXECUTE format('ALTER TABLE mbox.%I ENABLE ROW LEVEL SECURITY',n);
  EXECUTE format('ALTER TABLE mbox.%I FORCE ROW LEVEL SECURITY',n);
  EXECUTE format('CREATE POLICY scoped ON mbox.%I USING(tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id()) WITH CHECK(tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id())',n);
  EXECUTE format('CREATE TRIGGER immutable_row BEFORE UPDATE OR DELETE ON mbox.%I FOR EACH ROW EXECUTE FUNCTION mbox.reject_row_change()',n);
  EXECUTE format('GRANT SELECT,INSERT ON mbox.%I TO mbox_runtime',n);
 END LOOP;
END $$;
CREATE FUNCTION mbox.order_fully_settled_by_channel(t uuid,s uuid,o uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog,mbox AS $$
 SELECT EXISTS(SELECT 1 FROM mbox.orders ord JOIN mbox.pricing_authorizations a ON (a.tenant_id,a.store_id,a.order_id)=(ord.tenant_id,ord.store_id,ord.id)
 JOIN mbox.channel_price_quotes q ON (q.tenant_id,q.store_id,q.id)=(a.tenant_id,a.store_id,a.channel_quote_id)
 WHERE ord.tenant_id=t AND ord.store_id=s AND ord.id=o AND ord.total_amount_minor=0 AND a.status='consumed' AND a.source_type='channel_quote'
 AND (q.snapshot->>'payableMinor')::bigint=0 AND a.amount_minor=ord.discount_amount_minor
 AND (SELECT sum(p.amount_minor) FROM mbox.channel_price_applications p WHERE (p.tenant_id,p.store_id,p.quote_id,p.order_id)=(t,s,q.id,o))=a.amount_minor)
$$;
REVOKE ALL ON FUNCTION mbox.order_fully_settled_by_channel(uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mbox.order_fully_settled_by_channel(uuid,uuid,uuid) TO mbox_runtime;
DO $$ DECLARE body text; needle text:='mbox.order_fully_settled_by_checkout_quote(p_tenant,p_store,p_order)'; BEGIN
 SELECT pg_get_functiondef('mbox.order_consumption_settled(uuid,uuid,uuid)'::regprocedure) INTO body;
 IF position(needle IN body)=0 THEN RAISE EXCEPTION 'Unexpected consumption authority'; END IF;
 EXECUTE replace(body,needle,'('||needle||' OR mbox.order_fully_settled_by_channel(p_tenant,p_store,p_order))');
END $$;
UPDATE mbox.normalized_schema_metadata SET schema_version='308',updated_at=clock_timestamp() WHERE singleton=true;
COMMIT;
