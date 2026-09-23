BEGIN;

-- Canonical identity merge reconciles duplicate tag visibility and provenance.
-- Retain store RLS and grant only the columns used by its conflict update.
GRANT UPDATE (visibility, source) ON mbox.customer_tags TO mbox_runtime;

UPDATE mbox.normalized_schema_metadata SET schema_version='232',updated_at=clock_timestamp()
WHERE singleton=true AND schema_flavor='normalized-core-v1';
COMMIT;
