BEGIN;
CREATE TABLE mbox.social_accounts(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL,store_id uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN('service_account','wecom')),name text NOT NULL CHECK(length(name) BETWEEN 1 AND 80),
 app_id text NOT NULL CHECK(length(app_id) BETWEEN 5 AND 128),enabled boolean NOT NULL DEFAULT false,
 credential_hash text NOT NULL,encrypted_credentials bytea NOT NULL,key_id text NOT NULL,
 code_template_id text,code_data_key text NOT NULL DEFAULT 'character_string1',
 reminder_template_id text,reminder_data_key text NOT NULL DEFAULT 'thing1',
 created_by_employee_id uuid NOT NULL,updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(tenant_id,store_id,id),UNIQUE(tenant_id,store_id,kind,app_id),
 FOREIGN KEY(tenant_id,store_id) REFERENCES mbox.stores(tenant_id,id),
 FOREIGN KEY(tenant_id,store_id,created_by_employee_id) REFERENCES mbox.employees(tenant_id,store_id,id)
);
CREATE TABLE mbox.social_relationships(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL,store_id uuid NOT NULL,account_id uuid NOT NULL,
 external_hash text NOT NULL,encrypted_external_id bytea NOT NULL,key_id text NOT NULL,
 unionid_sha256 text,customer_id uuid,staff_external_id text NOT NULL DEFAULT '',active boolean NOT NULL,
 provider_occurred_at timestamptz NOT NULL,verified_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(tenant_id,store_id,id),UNIQUE(tenant_id,store_id,account_id,external_hash,staff_external_id),
 FOREIGN KEY(tenant_id,store_id,account_id) REFERENCES mbox.social_accounts(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,store_id,customer_id) REFERENCES mbox.customers(tenant_id,store_id,id)
);
CREATE INDEX social_relationship_customer ON mbox.social_relationships(tenant_id,store_id,customer_id,account_id,active);
CREATE TABLE mbox.social_callback_events(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL,store_id uuid NOT NULL,account_id uuid NOT NULL,
 fingerprint text NOT NULL,event_type text NOT NULL,provider_occurred_at timestamptz NOT NULL,
 payload_hash text NOT NULL,encrypted_payload bytea NOT NULL,key_id text NOT NULL,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN('pending','processed','failed')),error_code text,
 received_at timestamptz NOT NULL DEFAULT clock_timestamp(),processed_at timestamptz,
 UNIQUE(tenant_id,store_id,account_id,fingerprint),
 FOREIGN KEY(tenant_id,store_id,account_id) REFERENCES mbox.social_accounts(tenant_id,store_id,id)
);
ALTER TABLE mbox.member_card_projects ADD COLUMN artist_name text NOT NULL DEFAULT '',ADD COLUMN icon_url text,
 ADD COLUMN service_account_id uuid,ADD COLUMN wecom_account_id uuid,ADD COLUMN require_social_conditions boolean NOT NULL DEFAULT false,
 ADD COLUMN auto_restore boolean NOT NULL DEFAULT false;
ALTER TABLE mbox.member_card_projects ADD FOREIGN KEY(tenant_id,store_id,service_account_id) REFERENCES mbox.social_accounts(tenant_id,store_id,id),
 ADD FOREIGN KEY(tenant_id,store_id,wecom_account_id) REFERENCES mbox.social_accounts(tenant_id,store_id,id),
 ADD CHECK(NOT require_social_conditions OR(service_account_id IS NOT NULL AND wecom_account_id IS NOT NULL));
ALTER TABLE mbox.member_cards ADD COLUMN social_suspended boolean NOT NULL DEFAULT false;
ALTER TABLE mbox.bottle_custody_policies ADD COLUMN service_account_id uuid,
 ADD FOREIGN KEY(tenant_id,store_id,service_account_id) REFERENCES mbox.social_accounts(tenant_id,store_id,id);
CREATE FUNCTION mbox.card_social_conditions_met(p_tenant uuid,p_store uuid,p_project uuid,p_customer uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT COALESCE((SELECT NOT p.require_social_conditions OR (
 EXISTS(SELECT 1 FROM mbox.social_relationships r JOIN mbox.social_accounts a ON a.tenant_id=r.tenant_id AND a.store_id=r.store_id AND a.id=r.account_id WHERE r.tenant_id=p_tenant AND r.store_id=p_store AND r.account_id=p.service_account_id AND a.kind='service_account' AND a.enabled AND r.active AND mbox.canonical_customer_id(r.tenant_id,r.store_id,r.customer_id)=mbox.canonical_customer_id(p_tenant,p_store,p_customer))
 AND EXISTS(SELECT 1 FROM mbox.social_relationships r JOIN mbox.social_accounts a ON a.tenant_id=r.tenant_id AND a.store_id=r.store_id AND a.id=r.account_id WHERE r.tenant_id=p_tenant AND r.store_id=p_store AND r.account_id=p.wecom_account_id AND a.kind='wecom' AND a.enabled AND r.active AND mbox.canonical_customer_id(r.tenant_id,r.store_id,r.customer_id)=mbox.canonical_customer_id(p_tenant,p_store,p_customer))
 ) FROM mbox.member_card_projects p WHERE p.tenant_id=p_tenant AND p.store_id=p_store AND p.id=p_project),false)
$$;
REVOKE ALL ON FUNCTION mbox.card_social_conditions_met(uuid,uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mbox.card_social_conditions_met(uuid,uuid,uuid,uuid) TO mbox_runtime;
DO $$ DECLARE n text; BEGIN
 FOREACH n IN ARRAY ARRAY['social_accounts','social_relationships','social_callback_events'] LOOP
  EXECUTE format('ALTER TABLE mbox.%I ENABLE ROW LEVEL SECURITY',n);
  EXECUTE format('ALTER TABLE mbox.%I FORCE ROW LEVEL SECURITY',n);
  EXECUTE format('CREATE POLICY tenant_store_isolation ON mbox.%I USING(tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id()) WITH CHECK(tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id())',n);
  EXECUTE format('REVOKE ALL ON mbox.%I FROM PUBLIC,mbox_runtime',n);
  EXECUTE format('GRANT SELECT,INSERT,UPDATE ON mbox.%I TO mbox_runtime',n);
 END LOOP;
END $$;
ALTER TABLE mbox.bottle_custody_challenges ADD COLUMN claimed_at timestamptz;
ALTER TABLE mbox.bottle_custody_reminders ADD COLUMN claimed_at timestamptz;
UPDATE mbox.normalized_schema_metadata SET schema_version='207',updated_at=clock_timestamp() WHERE singleton=true;
COMMIT;
