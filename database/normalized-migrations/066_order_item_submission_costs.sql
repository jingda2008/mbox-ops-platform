BEGIN;

ALTER TABLE mbox.order_items
  ADD COLUMN unit_cost_minor_at_submission bigint,
  ADD COLUMN total_cost_minor_at_submission bigint,
  ADD COLUMN cost_source text NOT NULL DEFAULT 'unavailable',
  ADD COLUMN cost_reference_product_id uuid,
  ADD COLUMN cost_reference_order_item_id uuid,
  ADD COLUMN cost_reference_product_updated_at timestamptz;

-- Historical JSON is accepted only once, during migration, and only when its
-- numeric shape is exact and internally consistent. Missing or contradictory
-- history remains explicitly unavailable; current catalog cost is never used
-- to invent a historical submission cost.
WITH parsed AS (
  SELECT item.id, item.quantity, item.product_id,
    item.cost_snapshot ? 'unitCostMinor' AS unit_cost_present,
    item.cost_snapshot ? 'totalCostMinor' AS total_cost_present,
    CASE
      WHEN item.cost_snapshot->>'unitCostMinor' ~ '^\d{1,16}$'
       AND (item.cost_snapshot->>'unitCostMinor')::numeric <= 9007199254740991
      THEN (item.cost_snapshot->>'unitCostMinor')::bigint
      ELSE NULL
    END AS unit_cost,
    CASE
      WHEN item.cost_snapshot->>'totalCostMinor' ~ '^\d{1,16}$'
       AND (item.cost_snapshot->>'totalCostMinor')::numeric <= 9007199254740991
      THEN (item.cost_snapshot->>'totalCostMinor')::bigint
      ELSE NULL
    END AS total_cost
  FROM mbox.order_items AS item
  WHERE item.parent_order_item_id IS NULL
), accepted AS (
  SELECT parsed.*,
    CASE
      WHEN (unit_cost_present AND unit_cost IS NULL)
        OR (total_cost_present AND total_cost IS NULL)
      THEN NULL
      WHEN unit_cost IS NOT NULL
       AND unit_cost::numeric * quantity <= 9007199254740991
       AND (total_cost IS NULL OR total_cost = unit_cost * quantity)
      THEN unit_cost * quantity
      WHEN NOT unit_cost_present AND total_cost IS NOT NULL
      THEN total_cost
      ELSE NULL
    END AS accepted_total
  FROM parsed
)
UPDATE mbox.order_items AS item
SET unit_cost_minor_at_submission = CASE WHEN accepted.accepted_total IS NULL
      THEN NULL ELSE accepted.unit_cost END,
    total_cost_minor_at_submission = accepted.accepted_total,
    cost_source = CASE WHEN accepted.accepted_total IS NULL
      THEN 'unavailable' ELSE 'legacy_snapshot' END,
    cost_reference_product_id = CASE WHEN accepted.accepted_total IS NULL
      THEN NULL ELSE accepted.product_id END
FROM accepted
WHERE item.id=accepted.id;

-- Bundle components are operational rows. Their product cost is already
-- carried by the billable bundle parent, so direct contribution cost is zero
-- and the exact parent row is the strong reference.
UPDATE mbox.order_items
SET unit_cost_minor_at_submission=0,
    total_cost_minor_at_submission=0,
    cost_source='included_in_parent',
    cost_reference_product_id=NULL,
    cost_reference_order_item_id=parent_order_item_id,
    cost_reference_product_updated_at=NULL
WHERE parent_order_item_id IS NOT NULL;

ALTER TABLE mbox.order_items
  ADD CONSTRAINT order_items_cost_source_ck CHECK (cost_source IN (
    'catalog_product', 'legacy_snapshot', 'included_in_parent', 'unavailable'
  )),
  ADD CONSTRAINT order_items_cost_reference_product_fk
    FOREIGN KEY (tenant_id, store_id, cost_reference_product_id)
    REFERENCES mbox.products(tenant_id, store_id, id),
  ADD CONSTRAINT order_items_cost_reference_order_item_fk
    FOREIGN KEY (tenant_id, store_id, cost_reference_order_item_id)
    REFERENCES mbox.order_items(tenant_id, store_id, id),
  ADD CONSTRAINT order_items_submission_cost_ck CHECK (
    CASE cost_source
      WHEN 'catalog_product' THEN
        parent_order_item_id IS NULL
        AND unit_cost_minor_at_submission IS NOT NULL
        AND total_cost_minor_at_submission IS NOT NULL
        AND unit_cost_minor_at_submission >= 0
        AND total_cost_minor_at_submission = unit_cost_minor_at_submission * quantity
        AND cost_reference_product_id=product_id
        AND cost_reference_order_item_id IS NULL
        AND cost_reference_product_updated_at IS NOT NULL
      WHEN 'legacy_snapshot' THEN
        parent_order_item_id IS NULL
        AND total_cost_minor_at_submission IS NOT NULL
        AND total_cost_minor_at_submission >= 0
        AND (unit_cost_minor_at_submission IS NULL OR unit_cost_minor_at_submission >= 0)
        AND (unit_cost_minor_at_submission IS NULL
          OR total_cost_minor_at_submission=unit_cost_minor_at_submission * quantity)
        AND cost_reference_product_id=product_id
        AND cost_reference_order_item_id IS NULL
        AND cost_reference_product_updated_at IS NULL
      WHEN 'included_in_parent' THEN
        parent_order_item_id IS NOT NULL
        AND unit_cost_minor_at_submission=0
        AND total_cost_minor_at_submission=0
        AND cost_reference_product_id IS NULL
        AND cost_reference_order_item_id=parent_order_item_id
        AND cost_reference_product_updated_at IS NULL
      ELSE
        unit_cost_minor_at_submission IS NULL
        AND total_cost_minor_at_submission IS NULL
        AND cost_reference_product_id IS NULL
        AND cost_reference_order_item_id IS NULL
        AND cost_reference_product_updated_at IS NULL
    END
  );

COMMENT ON COLUMN mbox.order_items.unit_cost_minor_at_submission IS
  'Strong catalog unit cost frozen by the order transaction; NULL only for unavailable legacy history.';
COMMENT ON COLUMN mbox.order_items.total_cost_minor_at_submission IS
  'Strong contribution cost frozen at order submission; runtime readers must not parse cost_snapshot.';
COMMENT ON COLUMN mbox.order_items.cost_source IS
  'Typed authority: catalog_product, legacy_snapshot, included_in_parent, or unavailable.';
COMMENT ON COLUMN mbox.order_items.cost_reference_product_updated_at IS
  'Exact products.updated_at value locked and observed by the order transaction.';
COMMENT ON COLUMN mbox.order_items.cost_snapshot IS
  'Non-authoritative historical display only; runtime cost and contribution calculations must use strong columns.';

CREATE OR REPLACE FUNCTION mbox.protect_order_item_submission_costs()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, mbox
AS $$
BEGIN
  IF ROW(
    NEW.unit_cost_minor_at_submission,
    NEW.total_cost_minor_at_submission,
    NEW.cost_source,
    NEW.cost_reference_product_id,
    NEW.cost_reference_order_item_id,
    NEW.cost_reference_product_updated_at
  ) IS DISTINCT FROM ROW(
    OLD.unit_cost_minor_at_submission,
    OLD.total_cost_minor_at_submission,
    OLD.cost_source,
    OLD.cost_reference_product_id,
    OLD.cost_reference_order_item_id,
    OLD.cost_reference_product_updated_at
  ) THEN
    RAISE EXCEPTION 'Order item submission cost evidence is immutable'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER order_items_submission_costs_immutable
  BEFORE UPDATE ON mbox.order_items
  FOR EACH ROW EXECUTE FUNCTION mbox.protect_order_item_submission_costs();

UPDATE mbox.normalized_schema_metadata
SET schema_version='066', updated_at=clock_timestamp()
WHERE singleton=true AND schema_flavor='normalized-core-v1';

COMMIT;
