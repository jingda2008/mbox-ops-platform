BEGIN;
-- Additive and closed by default. No partner, coupon or historical attribution
-- is manufactured by this migration.
CREATE TABLE mbox.channel_partners (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL,store_id uuid NOT NULL,
 name text NOT NULL CHECK(length(btrim(name)) BETWEEN 2 AND 100),
 settlement_subject text NOT NULL CHECK(length(btrim(settlement_subject)) BETWEEN 2 AND 200),
 status text NOT NULL DEFAULT 'active' CHECK(status IN('active','paused')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(tenant_id,store_id,id),FOREIGN KEY(tenant_id,store_id) REFERENCES mbox.stores(tenant_id,id)
);
CREATE TABLE mbox.channel_promoters (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL,store_id uuid NOT NULL,
 partner_id uuid NOT NULL,name text NOT NULL CHECK(length(btrim(name)) BETWEEN 1 AND 100),
 customer_id uuid,status text NOT NULL DEFAULT 'active' CHECK(status IN('active','disabled')),
 can_confirm_statement boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(tenant_id,store_id,id),UNIQUE(tenant_id,store_id,partner_id,id),
 UNIQUE(tenant_id,store_id,customer_id),
 FOREIGN KEY(tenant_id,store_id,partner_id) REFERENCES mbox.channel_partners(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,store_id,customer_id) REFERENCES mbox.customers(tenant_id,store_id,id)
);
CREATE TABLE mbox.channel_invitations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL,store_id uuid NOT NULL,promoter_id uuid NOT NULL,
 token_hash char(64) NOT NULL CHECK(token_hash ~ '^[0-9a-f]{64}$'),expires_at timestamptz NOT NULL,
 accepted_customer_id uuid,accepted_at timestamptz,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(tenant_id,store_id,token_hash),CHECK((accepted_customer_id IS NULL)=(accepted_at IS NULL)),
 FOREIGN KEY(tenant_id,store_id,promoter_id) REFERENCES mbox.channel_promoters(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,store_id,accepted_customer_id) REFERENCES mbox.customers(tenant_id,store_id,id)
);
CREATE TABLE mbox.channel_campaigns (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL,store_id uuid NOT NULL,
 title text NOT NULL CHECK(length(btrim(title)) BETWEEN 2 AND 100),
 claim_limit integer NOT NULL CHECK(claim_limit BETWEEN 1 AND 1000000),
 capacity_limit integer NOT NULL CHECK(capacity_limit BETWEEN 1 AND 1000000),
 cost_limit_minor bigint NOT NULL CHECK(cost_limit_minor BETWEEN 0 AND 1000000000000),
 accepting_claims boolean NOT NULL DEFAULT false,staff_entry_enabled boolean NOT NULL DEFAULT false,self_entry_enabled boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(tenant_id,store_id,id),FOREIGN KEY(tenant_id,store_id) REFERENCES mbox.stores(tenant_id,id)
);
CREATE TABLE mbox.channel_batches (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL,store_id uuid NOT NULL,
 campaign_id uuid NOT NULL,partner_id uuid NOT NULL,promoter_id uuid NOT NULL,
 offer_code text NOT NULL CHECK(offer_code ~ '^[A-Z2-9]{8,16}$'),public_token text NOT NULL CHECK(public_token ~ '^[A-Za-z0-9_-]{32,80}$'),
 rule_snapshot jsonb NOT NULL CHECK(jsonb_typeof(rule_snapshot)='object' AND rule_snapshot ?& ARRAY['totalClaims','perCustomerClaims','perVisitUses','claimFrom','claimUntil','useFrom','useUntil','offer']),
 contract_snapshot jsonb NOT NULL CHECK(jsonb_typeof(contract_snapshot)='object'),
 accepting_claims boolean NOT NULL DEFAULT false,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(tenant_id,store_id,id),UNIQUE(tenant_id,store_id,offer_code),UNIQUE(public_token),
 FOREIGN KEY(tenant_id,store_id,campaign_id) REFERENCES mbox.channel_campaigns(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,store_id,partner_id,promoter_id) REFERENCES mbox.channel_promoters(tenant_id,store_id,partner_id,id),
 CHECK((rule_snapshot->>'totalClaims')::integer BETWEEN 1 AND 1000000),
 CHECK((rule_snapshot->>'perCustomerClaims')::integer BETWEEN 1 AND (rule_snapshot->>'totalClaims')::integer),
 CHECK((rule_snapshot->>'perVisitUses')::integer BETWEEN 1 AND 100)
);
CREATE TABLE mbox.channel_visits (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL,store_id uuid NOT NULL,
 source_batch_id uuid,locked_use_limit integer CHECK(locked_use_limit BETWEEN 1 AND 100),
 arrival_confirmed_at timestamptz,arrival_confirmed_by_employee_id uuid,
 opened_at timestamptz NOT NULL DEFAULT clock_timestamp(),closed_at timestamptz,version bigint NOT NULL DEFAULT 1 CHECK(version>0),
 UNIQUE(tenant_id,store_id,id),FOREIGN KEY(tenant_id,store_id) REFERENCES mbox.stores(tenant_id,id),
 FOREIGN KEY(tenant_id,store_id,source_batch_id) REFERENCES mbox.channel_batches(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,store_id,arrival_confirmed_by_employee_id) REFERENCES mbox.employees(tenant_id,store_id,id),
 CHECK((arrival_confirmed_at IS NULL)=(arrival_confirmed_by_employee_id IS NULL)),
 CHECK((source_batch_id IS NULL)=(locked_use_limit IS NULL))
);
CREATE TABLE mbox.channel_visit_tables (
 tenant_id uuid NOT NULL,store_id uuid NOT NULL,visit_id uuid NOT NULL,table_session_id uuid NOT NULL,
 attached_at timestamptz NOT NULL DEFAULT clock_timestamp(),detached_at timestamptz,
 PRIMARY KEY(tenant_id,store_id,visit_id,table_session_id),
 FOREIGN KEY(tenant_id,store_id,visit_id) REFERENCES mbox.channel_visits(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,store_id,table_session_id) REFERENCES mbox.table_sessions(tenant_id,store_id,id)
);
CREATE UNIQUE INDEX channel_table_visit_idx ON mbox.channel_visit_tables(tenant_id,store_id,table_session_id) WHERE detached_at IS NULL;
CREATE TABLE mbox.channel_claims (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL,store_id uuid NOT NULL,
 batch_id uuid NOT NULL,customer_id uuid NOT NULL,entry text NOT NULL CHECK(entry IN('staff','self')),
 status text NOT NULL DEFAULT 'available' CHECK(status IN('available','active','fulfilled','expired','revoked')),
 cost_commitment_minor bigint NOT NULL CHECK(cost_commitment_minor>=0),
 voided boolean NOT NULL DEFAULT false,issued_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 use_until_override timestamptz,version bigint NOT NULL DEFAULT 1 CHECK(version>0),
 UNIQUE(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,store_id,batch_id) REFERENCES mbox.channel_batches(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,store_id,customer_id) REFERENCES mbox.customers(tenant_id,store_id,id)
);
CREATE INDEX channel_claim_customer_idx ON mbox.channel_claims(tenant_id,store_id,customer_id,batch_id);
CREATE INDEX channel_claim_batch_idx ON mbox.channel_claims(tenant_id,store_id,batch_id,status);
CREATE TABLE mbox.channel_activations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL,store_id uuid NOT NULL,
 claim_id uuid NOT NULL,visit_id uuid NOT NULL,table_session_id uuid NOT NULL,
 status text NOT NULL DEFAULT 'active' CHECK(status IN('active','fulfilled','cancelled')),
 applied_discount_minor bigint NOT NULL DEFAULT 0 CHECK(applied_discount_minor>=0),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),fulfilled_at timestamptz,cancelled_at timestamptz,
 UNIQUE(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,store_id,claim_id) REFERENCES mbox.channel_claims(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,store_id,visit_id,table_session_id) REFERENCES mbox.channel_visit_tables(tenant_id,store_id,visit_id,table_session_id)
);
CREATE UNIQUE INDEX channel_claim_active_uq ON mbox.channel_activations(tenant_id,store_id,claim_id) WHERE status IN('active','fulfilled');
CREATE INDEX channel_visit_uses_idx ON mbox.channel_activations(tenant_id,store_id,visit_id,status);
CREATE TABLE mbox.channel_order_attributions (
 tenant_id uuid NOT NULL,store_id uuid NOT NULL,order_id uuid NOT NULL,visit_id uuid NOT NULL,batch_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,store_id,order_id),
 FOREIGN KEY(tenant_id,store_id,order_id) REFERENCES mbox.orders(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,store_id,visit_id) REFERENCES mbox.channel_visits(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,store_id,batch_id) REFERENCES mbox.channel_batches(tenant_id,store_id,id)
);
CREATE TABLE mbox.channel_ledger (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL,store_id uuid NOT NULL,
 visit_id uuid NOT NULL,batch_id uuid NOT NULL,event_key text NOT NULL CHECK(length(event_key) BETWEEN 1 AND 200),
 net_basis_minor bigint NOT NULL CHECK(net_basis_minor>=0),commission_delta_minor bigint NOT NULL,
 evidence jsonb NOT NULL CHECK(jsonb_typeof(evidence)='object'),matures_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(tenant_id,store_id,id),UNIQUE(tenant_id,store_id,event_key),
 FOREIGN KEY(tenant_id,store_id,visit_id) REFERENCES mbox.channel_visits(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,store_id,batch_id) REFERENCES mbox.channel_batches(tenant_id,store_id,id)
);
CREATE TABLE mbox.channel_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL,store_id uuid NOT NULL,
 object_id uuid NOT NULL,event_type text NOT NULL,actor_ref text NOT NULL,reason text NOT NULL,
 payload jsonb NOT NULL CHECK(jsonb_typeof(payload)='object'),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(tenant_id,store_id) REFERENCES mbox.stores(tenant_id,id)
);
CREATE TABLE mbox.channel_followups (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL,store_id uuid NOT NULL,
 promoter_id uuid NOT NULL,batch_id uuid,employee_id uuid,actor_ref text NOT NULL,
 kind text NOT NULL CHECK(kind IN('download','sent','received','feedback','contact')),
 note text NOT NULL CHECK(length(note)<=2000),next_contact_at timestamptz,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(tenant_id,store_id,promoter_id) REFERENCES mbox.channel_promoters(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,store_id,batch_id) REFERENCES mbox.channel_batches(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,store_id,employee_id) REFERENCES mbox.employees(tenant_id,store_id,id)
);
CREATE FUNCTION mbox.freeze_channel_batch_terms() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (NEW.campaign_id,NEW.partner_id,NEW.promoter_id,NEW.offer_code,NEW.public_token,NEW.rule_snapshot,NEW.contract_snapshot)
 IS DISTINCT FROM (OLD.campaign_id,OLD.partner_id,OLD.promoter_id,OLD.offer_code,OLD.public_token,OLD.rule_snapshot,OLD.contract_snapshot)
 THEN RAISE EXCEPTION 'Issued channel batch terms are immutable' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER channel_batch_terms_immutable BEFORE UPDATE ON mbox.channel_batches FOR EACH ROW EXECUTE FUNCTION mbox.freeze_channel_batch_terms();
DO $$ DECLARE n text; BEGIN
 FOREACH n IN ARRAY ARRAY['channel_partners','channel_promoters','channel_invitations','channel_campaigns','channel_batches','channel_visits','channel_visit_tables','channel_claims','channel_activations','channel_order_attributions','channel_ledger','channel_events','channel_followups'] LOOP
  EXECUTE format('ALTER TABLE mbox.%I ENABLE ROW LEVEL SECURITY',n);
  EXECUTE format('ALTER TABLE mbox.%I FORCE ROW LEVEL SECURITY',n);
  EXECUTE format('CREATE POLICY tenant_store_isolation ON mbox.%I USING(tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id()) WITH CHECK(tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id())',n);
  EXECUTE format('REVOKE ALL ON mbox.%I FROM PUBLIC,mbox_runtime',n);
  EXECUTE format('GRANT SELECT,INSERT ON mbox.%I TO mbox_runtime',n);
  IF n=ANY(ARRAY['channel_order_attributions','channel_ledger','channel_events','channel_followups']) THEN
   EXECUTE format('CREATE TRIGGER immutable_row BEFORE UPDATE OR DELETE ON mbox.%I FOR EACH ROW EXECUTE FUNCTION mbox.reject_row_change()',n);
  ELSE EXECUTE format('GRANT UPDATE ON mbox.%I TO mbox_runtime',n); END IF;
 END LOOP;
END $$;
CREATE FUNCTION mbox.seed_channel_permissions() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO mbox.staff_permission_definitions(tenant_id,store_id,code,name,category,description)
 SELECT NEW.tenant_id,NEW.id,v.code,v.name,'marketing',v.name FROM (VALUES
 ('channel.view','查看渠道推广'),('channel.manage','管理渠道活动与推广人员'),
 ('channel.activate','现场核验渠道券'),('channel.correct','更正渠道来源与权益'),
 ('channel.settle','审核渠道结算')) AS v(code,name) ON CONFLICT DO NOTHING;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION mbox.seed_channel_permissions() FROM PUBLIC;
CREATE TRIGGER stores_seed_channel_permissions AFTER INSERT ON mbox.stores FOR EACH ROW EXECUTE FUNCTION mbox.seed_channel_permissions();
INSERT INTO mbox.staff_permission_definitions(tenant_id,store_id,code,name,category,description)
 SELECT s.tenant_id,s.id,v.code,v.name,'marketing',v.name FROM mbox.stores s CROSS JOIN (VALUES
 ('channel.view','查看渠道推广'),('channel.manage','管理渠道活动与推广人员'),
 ('channel.activate','现场核验渠道券'),('channel.correct','更正渠道来源与权益'),
 ('channel.settle','审核渠道结算')) AS v(code,name) ON CONFLICT DO NOTHING;
-- Deliberately no automatic role grants. Store owners grant these capabilities
-- through the existing permission system after acceptance.
UPDATE mbox.normalized_schema_metadata SET schema_version='306',updated_at=clock_timestamp() WHERE singleton=true;
COMMIT;
