BEGIN;

-- A bundle is not a second manually priced stock input.  Its current cost is
-- derived from the current cost of the products it contains.  This keeps
-- fixed packages, tasting flights and combination offers aligned when a
-- component's weighted purchase cost changes.
ALTER TABLE mbox.products
  DROP CONSTRAINT IF EXISTS products_cost_source_check,
  DROP CONSTRAINT IF EXISTS products_cost_source_version_check;

ALTER TABLE mbox.products
  ADD CONSTRAINT products_cost_source_check
    CHECK (cost_source IN ('manual','recipe','bundle','incomplete')),
  ADD CONSTRAINT products_cost_source_version_check
    CHECK (
      (cost_source IN ('manual','bundle','incomplete') AND recipe_cost_version_id IS NULL)
      OR (cost_source='recipe' AND recipe_cost_version_id IS NOT NULL)
    );

-- Bring existing bundles onto the same automatic basis.  If any component is
-- unknown, the bundle remains sellable but honestly carries an incomplete
-- cost instead of a made-up zero-margin value.
WITH calculated AS (
  SELECT
    component.tenant_id,
    component.store_id,
    component.bundle_product_id,
    CASE
      WHEN bool_and(component_product.cost_amount_minor IS NOT NULL)
        AND sum(component_product.cost_amount_minor::numeric * component.quantity::numeric)
            <= 9007199254740991
      THEN sum(component_product.cost_amount_minor::numeric * component.quantity::numeric)::bigint
      ELSE NULL
    END AS cost_amount_minor
  FROM mbox.product_bundle_components AS component
  JOIN mbox.products AS component_product
    ON component_product.tenant_id=component.tenant_id
   AND component_product.store_id=component.store_id
   AND component_product.id=component.component_product_id
  GROUP BY component.tenant_id,component.store_id,component.bundle_product_id
)
UPDATE mbox.products AS bundle
SET cost_amount_minor=calculated.cost_amount_minor,
    cost_source=CASE
      WHEN calculated.cost_amount_minor IS NULL THEN 'incomplete'
      ELSE 'bundle'
    END,
    recipe_cost_version_id=NULL,
    updated_at=clock_timestamp()
FROM calculated
WHERE bundle.tenant_id=calculated.tenant_id
  AND bundle.store_id=calculated.store_id
  AND bundle.id=calculated.bundle_product_id
  AND bundle.product_kind='bundle';

UPDATE mbox.normalized_schema_metadata
SET schema_version='153',updated_at=clock_timestamp()
WHERE singleton=true AND schema_flavor='normalized-core-v1';

COMMIT;
