BEGIN;

ALTER TABLE mbox.membership_terms_acceptances
  DROP CONSTRAINT membership_terms_acceptances_acknowledgement_source_check,
  ADD CONSTRAINT membership_terms_acceptances_acknowledgement_source_check
    CHECK (acknowledgement_source IN ('mini_menu','mini_profile','mini_community'));

COMMENT ON COLUMN mbox.membership_terms_acceptances.acknowledgement_source IS
  'Customer-visible mini-program entry where the current published membership terms were explicitly accepted.';

UPDATE mbox.normalized_schema_metadata
SET schema_version='104',updated_at=clock_timestamp()
WHERE singleton=true AND schema_flavor='normalized-core-v1';

COMMIT;
