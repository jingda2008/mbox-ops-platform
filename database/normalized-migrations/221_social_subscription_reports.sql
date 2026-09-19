BEGIN;
-- A signed local OAuth identity and a browser report are not proof of unused
-- platform quota. Keep this audit separate from delivery and relationship facts.
CREATE TABLE mbox.social_subscription_reports (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL,store_id uuid NOT NULL,
 account_id uuid NOT NULL,authorization_ref text NOT NULL CHECK(authorization_ref ~ '^[0-9a-f]{64}$'),
 external_hash text NOT NULL,
 template_id text NOT NULL CHECK(length(template_id) BETWEEN 8 AND 128),
 reported_decision text NOT NULL CHECK(reported_decision IN('granted','denied','revoked')),
 source text NOT NULL DEFAULT 'client_report' CHECK(source='client_report'),
 reported_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(tenant_id,store_id,account_id,authorization_ref,template_id),
 FOREIGN KEY(tenant_id,store_id,account_id) REFERENCES mbox.social_accounts(tenant_id,store_id,id)
);
CREATE INDEX social_subscription_report_recipient ON mbox.social_subscription_reports(tenant_id,store_id,account_id,external_hash,reported_at DESC);
ALTER TABLE mbox.social_subscription_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE mbox.social_subscription_reports FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_store_isolation ON mbox.social_subscription_reports USING(tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id()) WITH CHECK(tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id());
REVOKE ALL ON mbox.social_subscription_reports FROM PUBLIC,mbox_runtime;
GRANT SELECT,INSERT ON mbox.social_subscription_reports TO mbox_runtime;
CREATE TRIGGER social_subscription_reports_append_only BEFORE UPDATE OR DELETE ON mbox.social_subscription_reports FOR EACH ROW EXECUTE FUNCTION mbox.reject_row_change();
CREATE INDEX media_assets_purpose_page ON mbox.media_assets(tenant_id,store_id,purpose,created_at DESC,id DESC);
UPDATE mbox.normalized_schema_metadata SET schema_version='221',updated_at=clock_timestamp() WHERE singleton=true;
COMMIT;
