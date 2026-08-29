BEGIN;

-- Migration 152 deliberately leaves opening/historical balances without a
-- guessed valuation.  A tracked sales product may still carry an older manual
-- or recipe amount, however, and that amount must not be frozen into a new
-- order while one of its active recipe inputs is awaiting cost confirmation.
-- Historic order snapshots are intentionally untouched.
UPDATE mbox.products AS product
SET cost_amount_minor=NULL,
    cost_source='incomplete',
    recipe_cost_version_id=NULL,
    updated_at=clock_timestamp()
WHERE product.product_kind='single'
  AND product.inventory_control_mode='tracked'
  AND (
    product.cost_source IS DISTINCT FROM 'recipe'
    OR product.recipe_cost_version_id IS NULL
    -- Existing cost versions receive receipt_line as their migration marker.
    -- They were calculated from a historical line, not from the newly
    -- introduced moving-weighted balance, so cannot become the next order's
    -- authoritative snapshot.
    OR EXISTS (
      SELECT 1
      FROM mbox.recipe_cost_components AS version_component
      WHERE version_component.tenant_id=product.tenant_id
        AND version_component.store_id=product.store_id
        AND version_component.recipe_cost_version_id=product.recipe_cost_version_id
        AND version_component.cost_basis='receipt_line'
    )
    OR NOT EXISTS (
      SELECT 1
      FROM mbox.recipe_cost_versions AS version
      JOIN mbox.recipes AS recipe
        ON recipe.tenant_id=version.tenant_id
       AND recipe.store_id=version.store_id
       AND recipe.id=version.recipe_id
      WHERE version.tenant_id=product.tenant_id
        AND version.store_id=product.store_id
        AND version.id=product.recipe_cost_version_id
        AND recipe.product_id=product.id
        AND recipe.status='active'
    )
    OR NOT EXISTS (
      SELECT 1
      FROM mbox.recipes AS recipe
      JOIN mbox.recipe_items AS component
        ON component.tenant_id=recipe.tenant_id
       AND component.store_id=recipe.store_id
       AND component.recipe_id=recipe.id
      LEFT JOIN mbox.inventory_balances AS balance
        ON balance.tenant_id=component.tenant_id
       AND balance.store_id=component.store_id
       AND balance.inventory_item_id=component.inventory_item_id
      WHERE recipe.tenant_id=product.tenant_id
        AND recipe.store_id=product.store_id
        AND recipe.product_id=product.id
        AND recipe.status='active'
        AND balance.cost_status='complete'
    )
    OR EXISTS (
      SELECT 1
      FROM mbox.recipes AS recipe
      JOIN mbox.recipe_items AS component
        ON component.tenant_id=recipe.tenant_id
       AND component.store_id=recipe.store_id
       AND component.recipe_id=recipe.id
      LEFT JOIN mbox.inventory_balances AS balance
        ON balance.tenant_id=component.tenant_id
       AND balance.store_id=component.store_id
       AND balance.inventory_item_id=component.inventory_item_id
      WHERE recipe.tenant_id=product.tenant_id
        AND recipe.store_id=product.store_id
        AND recipe.product_id=product.id
        AND recipe.status='active'
        AND (balance.inventory_item_id IS NULL OR balance.cost_status<>'complete')
    )
  );

-- Rebuild every bundle after the stale tracked-product values above have been
-- cleared.  A package remains sellable when a child cost is pending, but its
-- margin is explicitly incomplete rather than based on a historical guess.
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
SET schema_version='154',updated_at=clock_timestamp()
WHERE singleton=true AND schema_flavor='normalized-core-v1';

COMMIT;
