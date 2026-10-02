BEGIN;

-- A cancelled future assignment keeps its identity and audit history, but has
-- an empty responsibility interval. Existing active-assignment queries and
-- GiST overlap checks therefore exclude it without changing web contracts.
ALTER TABLE mbox.table_assignments
  ADD COLUMN cancelled_at timestamptz,
  ADD COLUMN cancelled_by_employee_id uuid,
  ADD COLUMN cancellation_reason text,
  ADD FOREIGN KEY (tenant_id,store_id,cancelled_by_employee_id)
    REFERENCES mbox.employees(tenant_id,store_id,id);

ALTER TABLE mbox.table_assignments DROP CONSTRAINT table_assignments_check;
ALTER TABLE mbox.table_assignments ADD CONSTRAINT table_assignments_interval_check CHECK (
  (cancelled_at IS NULL AND cancelled_by_employee_id IS NULL AND cancellation_reason IS NULL
    AND (ends_at IS NULL OR ends_at > starts_at))
  OR
  (cancelled_at IS NOT NULL AND cancelled_at < starts_at AND cancelled_by_employee_id IS NOT NULL
    AND cancellation_reason IS NOT NULL AND length(btrim(cancellation_reason)) BETWEEN 2 AND 1000
    AND ends_at IS NOT NULL AND ends_at = starts_at)
);

UPDATE mbox.normalized_schema_metadata SET schema_version='255',updated_at=clock_timestamp()
WHERE singleton=true AND schema_flavor='normalized-core-v1';
COMMIT;
