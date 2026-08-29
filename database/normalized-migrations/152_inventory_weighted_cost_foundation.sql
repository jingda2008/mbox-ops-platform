BEGIN;

-- A balance carries the current valuation of the stock that is actually on
-- hand.  It is deliberately nullable: old bottle-count history cannot be
-- silently converted to millilitres or assigned a guessed cost.
ALTER TABLE mbox.inventory_balances
  ADD COLUMN weighted_unit_cost_minor numeric(18,6),
  ADD COLUMN latest_purchase_unit_cost_minor numeric(18,6),
  ADD COLUMN cost_status text NOT NULL DEFAULT 'pending'
    CHECK (cost_status IN ('complete','pending','needs_review')),
  ADD COLUMN cost_basis text NOT NULL DEFAULT 'none'
    CHECK (cost_basis IN ('moving_weighted_average','manual_correction','none'));

ALTER TABLE mbox.inventory_balances
  ADD CONSTRAINT inventory_balances_weighted_cost_status_ck
  CHECK (
    (cost_status='complete' AND weighted_unit_cost_minor IS NOT NULL
      AND weighted_unit_cost_minor >= 0)
    OR (cost_status IN ('pending','needs_review') AND weighted_unit_cost_minor IS NULL)
  );

ALTER TABLE mbox.inventory_balances
  ADD CONSTRAINT inventory_balances_cost_basis_status_ck
  CHECK (
    (cost_status='complete' AND cost_basis IN ('moving_weighted_average','manual_correction'))
    OR (cost_status IN ('pending','needs_review') AND cost_basis='none')
  );

-- Receipt history alone is not enough to reconstruct a truthful opening
-- balance after historical sales, counts and bottle-unit data. Preserve it for
-- review instead of inventing a weighted average during migration.
UPDATE mbox.inventory_balances
SET cost_status=CASE WHEN on_hand_quantity=0 THEN 'pending' ELSE 'needs_review' END,
    weighted_unit_cost_minor=NULL,
    latest_purchase_unit_cost_minor=NULL,
    cost_basis='none';

COMMENT ON COLUMN mbox.inventory_balances.weighted_unit_cost_minor IS
  'Moving weighted purchase cost in minor currency per inventory base unit for stock currently on hand; NULL means do not guess.';
COMMENT ON COLUMN mbox.inventory_balances.latest_purchase_unit_cost_minor IS
  'Latest received purchase unit cost for comparison only; it is never the authoritative recipe valuation.';
COMMENT ON COLUMN mbox.inventory_balances.cost_status IS
  'complete when current stock has a known moving weighted cost; pending when empty/no receipt; needs_review when historical or count-added stock has no reliable valuation.';
COMMENT ON COLUMN mbox.inventory_balances.cost_basis IS
  'moving_weighted_average for receipt-derived stock, manual_correction only for a permissioned reviewed opening-cost correction, and none when no truthful current cost exists.';

-- A cost version calculated from a balance represents a weighted inventory
-- basis, not a fictional single receipt line. Keep old receipt lineage valid.
ALTER TABLE mbox.recipe_cost_components
  ALTER COLUMN source_receipt_line_id DROP NOT NULL,
  ADD COLUMN cost_basis text NOT NULL DEFAULT 'receipt_line'
    CHECK (cost_basis IN ('receipt_line','moving_weighted_average','manual_correction'));

ALTER TABLE mbox.products
  DROP CONSTRAINT IF EXISTS products_cost_source_check,
  DROP CONSTRAINT IF EXISTS products_cost_source_version_check;

ALTER TABLE mbox.products
  ADD CONSTRAINT products_cost_source_check
    CHECK (cost_source IN ('manual','recipe','incomplete')),
  ADD CONSTRAINT products_cost_source_version_check
    CHECK ((cost_source IN ('manual','incomplete') AND recipe_cost_version_id IS NULL)
      OR (cost_source='recipe' AND recipe_cost_version_id IS NOT NULL));

UPDATE mbox.products
SET cost_source='incomplete', recipe_cost_version_id=NULL
WHERE cost_amount_minor IS NULL AND cost_source='manual';

-- Corrections are exceptional: they establish a reviewed opening cost after a
-- count/history problem and retain the before/after evidence and reason.
CREATE TABLE mbox.inventory_cost_corrections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  inventory_item_id uuid NOT NULL,
  previous_weighted_unit_cost_minor numeric(18,6),
  resulting_weighted_unit_cost_minor numeric(18,6) NOT NULL CHECK (resulting_weighted_unit_cost_minor >= 0),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 2 AND 500),
  created_by_employee_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id,store_id) REFERENCES mbox.stores(tenant_id,id),
  FOREIGN KEY (tenant_id,store_id,inventory_item_id)
    REFERENCES mbox.inventory_items(tenant_id,store_id,id),
  FOREIGN KEY (tenant_id,store_id,created_by_employee_id)
    REFERENCES mbox.employees(tenant_id,store_id,id),
  UNIQUE (tenant_id,store_id,id)
);
CREATE INDEX inventory_cost_corrections_item_timeline_idx
  ON mbox.inventory_cost_corrections(tenant_id,store_id,inventory_item_id,created_at DESC,id DESC);
CREATE TRIGGER inventory_cost_corrections_append_only
  BEFORE UPDATE OR DELETE ON mbox.inventory_cost_corrections
  FOR EACH ROW EXECUTE FUNCTION mbox.reject_row_change();

ALTER TABLE mbox.inventory_cost_corrections ENABLE ROW LEVEL SECURITY;
ALTER TABLE mbox.inventory_cost_corrections FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_store_isolation ON mbox.inventory_cost_corrections
  USING (tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id())
  WITH CHECK (tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id());
REVOKE ALL ON TABLE mbox.inventory_cost_corrections FROM PUBLIC;
GRANT SELECT,INSERT ON TABLE mbox.inventory_cost_corrections TO mbox_runtime;

INSERT INTO mbox.staff_permission_definitions (
  tenant_id,store_id,code,name,category,description,status
)
SELECT store.tenant_id,store.id,
  'inventory.cost.correct','更正库存成本','inventory',
  '在盘点或历史库存待核对时，以原因留痕建立经复核的当前单位成本，不用于日常采购录入。','active'
FROM mbox.stores AS store
ON CONFLICT (tenant_id,store_id,code) DO UPDATE
SET name=EXCLUDED.name,category=EXCLUDED.category,
    description=EXCLUDED.description,status='active';

UPDATE mbox.normalized_schema_metadata
SET schema_version='152',updated_at=clock_timestamp()
WHERE singleton=true AND schema_flavor='normalized-core-v1';

COMMIT;
