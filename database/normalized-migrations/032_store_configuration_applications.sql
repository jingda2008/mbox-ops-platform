BEGIN;

CREATE TABLE mbox.store_configuration_applications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  config_version text NOT NULL CHECK (config_version ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'),
  config_sha256 char(64) NOT NULL CHECK (config_sha256 ~ '^[0-9a-f]{64}$'),
  source_commit_sha text NOT NULL CHECK (source_commit_sha ~ '^[0-9a-f]{7,64}$'),
  summary jsonb NOT NULL CHECK (jsonb_typeof(summary) = 'object'),
  applied_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  UNIQUE (tenant_id, store_id, config_version),
  UNIQUE (tenant_id, store_id, id)
);

ALTER TABLE mbox.store_configuration_applications ENABLE ROW LEVEL SECURITY;
ALTER TABLE mbox.store_configuration_applications FORCE ROW LEVEL SECURITY;
CREATE POLICY store_configuration_applications_tenant_store_policy
  ON mbox.store_configuration_applications
  USING (tenant_id = mbox.current_tenant_id() AND store_id = mbox.current_store_id())
  WITH CHECK (tenant_id = mbox.current_tenant_id() AND store_id = mbox.current_store_id());

GRANT SELECT, INSERT ON TABLE mbox.store_configuration_applications TO mbox_runtime;

UPDATE mbox.normalized_schema_metadata
SET schema_version = '032', updated_at = clock_timestamp()
WHERE singleton = true AND schema_flavor = 'normalized-core-v1';

COMMIT;
