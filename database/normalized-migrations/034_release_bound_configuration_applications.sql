BEGIN;

ALTER TABLE mbox.store_configuration_applications
  DROP CONSTRAINT store_configuration_applicati_tenant_id_store_id_config_ver_key,
  ADD CONSTRAINT store_configuration_applications_release_key
    UNIQUE (tenant_id, store_id, config_version, source_commit_sha);

ALTER TABLE mbox.product_catalog_applications
  DROP CONSTRAINT product_catalog_applications_tenant_id_store_id_catalog_ver_key,
  ADD CONSTRAINT product_catalog_applications_release_key
    UNIQUE (tenant_id, store_id, catalog_version, source_commit_sha);

UPDATE mbox.normalized_schema_metadata
SET schema_version = '034', updated_at = clock_timestamp()
WHERE singleton = true AND schema_flavor = 'normalized-core-v1';

COMMIT;
