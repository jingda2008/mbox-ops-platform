BEGIN;

-- Migration 044 copied legacy product_snapshot operational keys into typed
-- columns during the rollback window.  Keeping that trigger on the default
-- normalized write path lets an empty snapshot overwrite authoritative typed
-- values (including product cost) on INSERT.  Historical display snapshots
-- remain available, but they no longer drive runtime eligibility or money.
DROP TRIGGER IF EXISTS products_operational_rollback_compatibility ON mbox.products;
DROP FUNCTION IF EXISTS mbox.sync_product_operational_rollback_compatibility();

COMMENT ON COLUMN mbox.products.product_snapshot IS
  'Flexible historical/display snapshot only. Runtime visibility, search, recommendation, limits, timing, routing, SLA and cost are written and read from typed columns.';

UPDATE mbox.normalized_schema_metadata
SET schema_version = '056', updated_at = clock_timestamp()
WHERE singleton = true AND schema_flavor = 'normalized-core-v1';

COMMIT;
