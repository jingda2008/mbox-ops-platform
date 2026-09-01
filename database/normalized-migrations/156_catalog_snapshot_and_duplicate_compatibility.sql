BEGIN;

-- Operational catalog values moved to typed columns in migration 044. Strip
-- their legacy JSON copies so current clients can round-trip display metadata
-- without resubmitting fields that the API intentionally rejects.
WITH top_level_cleaned AS (
  SELECT id,tenant_id,store_id,
    product_snapshot - ARRAY[
      'guestVisible','searchText','sortOrder','availableFrom','availableUntil',
      'allowedChannels','maxOrderQuantity','kdsPriority','fulfillmentSlaSeconds',
      'costAmount','orderWindows'
    ]::text[] AS snapshot
  FROM mbox.products
), recommendation_cleaned AS (
  SELECT id,tenant_id,store_id,
    CASE WHEN jsonb_typeof(snapshot->'recommendation')='object' THEN
      jsonb_set(snapshot,'{recommendation}',(snapshot->'recommendation') - ARRAY[
        'guestVisible','searchText','sortOrder','availableFrom','availableUntil',
        'allowedChannels','maxOrderQuantity','kdsPriority','fulfillmentSlaSeconds',
        'costAmount','orderWindows','enabled','minimumPartySize','maximumPartySize',
        'priority','sceneTags','intentTags','tasteTags','dwellTags',
        'singleWaveEligible','expectedPrepMinutes','holdMinutes','upgradeProductId'
      ]::text[],false)
    ELSE snapshot END AS snapshot
  FROM top_level_cleaned
), display_only AS (
  SELECT id,tenant_id,store_id,
    CASE WHEN jsonb_typeof(snapshot->'source')='object' THEN
      jsonb_set(snapshot,'{source}',(snapshot->'source') - ARRAY[
        'guestVisible','searchText','sortOrder','availableFrom','availableUntil',
        'allowedChannels','maxOrderQuantity','kdsPriority','fulfillmentSlaSeconds',
        'costAmount','orderWindows','enabled','minimumPartySize','maximumPartySize',
        'priority','sceneTags','intentTags','tasteTags','dwellTags',
        'singleWaveEligible','expectedPrepMinutes','holdMinutes','upgradeProductId'
      ]::text[],false)
    ELSE snapshot END AS snapshot
  FROM recommendation_cleaned
)
UPDATE mbox.products product
SET product_snapshot=display_only.snapshot
FROM display_only
WHERE product.tenant_id=display_only.tenant_id AND product.store_id=display_only.store_id
  AND product.id=display_only.id
  AND product.product_snapshot IS DISTINCT FROM display_only.snapshot;

-- The production catalog accumulated a bounded set of active V2/V3 seed
-- products after their operational barcode/recipe-backed replacements were added.
-- Only pair explicitly known seed codes with a same-name, same-kind canonical
-- product in the same store; otherwise leave the row untouched for review.
CREATE TEMPORARY TABLE catalog_duplicate_pairs ON COMMIT DROP AS
WITH mapping(legacy_code,canonical_code) AS (VALUES
  ('V2-WINE-PENFOLDS-128','CXW003'),
  ('V2-COCKTAIL-WHISKEY-SOUR','CK019'),
  ('V2-CHAMPAGNE-PERRIER','3113880103819'),
  ('V3-SPIRIT-JACK-DANIELS','5099873026045'),
  ('V3-SPIRIT-GLENLIVET-12','080432402825'),
  ('V2-COCKTAIL-PINA-COLADA','CK028'),
  ('V2-MBOX-SIGNATURE','CK001'),
  ('V2-COCKTAIL-MOJITO','CK025'),
  ('V3-COGNAC-HENNESSY-VSOP','3245999491805'),
  ('V3-SIGNATURE-URBAN-OASIS','CK002'),
  ('V2-CHAMPAGNE-MOET','3185370228610'),
  ('V2-COCKTAIL-GIN-TONIC','CK026'),
  ('V2-COCKTAIL-LONG-ISLAND','CK022'),
  ('V2-SPIRIT-MACALLAN-BLUE','5010314302837'),
  ('V2-SPIRIT-ENTRY-2','5000267024202'),
  ('V2-COCKTAIL-SUNRISE','CK020')
)
SELECT legacy.tenant_id,legacy.store_id,legacy.id AS legacy_id,canonical.id AS canonical_id
FROM mapping
JOIN mbox.products legacy ON legacy.code=mapping.legacy_code
JOIN mbox.products canonical
  ON canonical.tenant_id=legacy.tenant_id AND canonical.store_id=legacy.store_id
 AND canonical.code=mapping.canonical_code
 AND canonical.product_kind=legacy.product_kind
 AND regexp_replace(lower(canonical.name),'[[:space:]（）()·._-]+','','g')
   =regexp_replace(lower(legacy.name),'[[:space:]（）()·._-]+','','g')
WHERE legacy.status IN ('active','sold_out')
  AND canonical.status IN ('active','sold_out');

-- Preserve bundles by moving any seed-product component to its canonical
-- counterpart before the seed product is retired. If both were present,
-- merge their quantities rather than dropping either component silently.
INSERT INTO mbox.product_bundle_components(
  tenant_id,store_id,bundle_product_id,component_product_id,quantity,sort_order,note
)
SELECT component.tenant_id,component.store_id,component.bundle_product_id,
  pair.canonical_id,component.quantity,component.sort_order,component.note
FROM mbox.product_bundle_components component
JOIN catalog_duplicate_pairs pair
  ON pair.tenant_id=component.tenant_id AND pair.store_id=component.store_id
 AND pair.legacy_id=component.component_product_id
ON CONFLICT (tenant_id,store_id,bundle_product_id,component_product_id)
DO UPDATE SET
  quantity=LEAST(999,mbox.product_bundle_components.quantity+EXCLUDED.quantity),
  sort_order=LEAST(mbox.product_bundle_components.sort_order,EXCLUDED.sort_order),
  note=COALESCE(mbox.product_bundle_components.note,EXCLUDED.note);

DELETE FROM mbox.product_bundle_components component
USING catalog_duplicate_pairs pair
WHERE pair.tenant_id=component.tenant_id AND pair.store_id=component.store_id
  AND pair.legacy_id=component.component_product_id;

-- Component identity changed, so recompute every bundle's current cost from
-- the resulting authoritative component set in the same transaction.
WITH calculated AS (
  SELECT component.tenant_id,component.store_id,component.bundle_product_id,
    CASE
      WHEN bool_and(component_product.cost_amount_minor IS NOT NULL)
        AND sum(component_product.cost_amount_minor::numeric*component.quantity::numeric)
          <= 9007199254740991
      THEN sum(component_product.cost_amount_minor::numeric*component.quantity::numeric)::bigint
      ELSE NULL
    END AS cost_amount_minor
  FROM mbox.product_bundle_components component
  JOIN mbox.products component_product
    ON component_product.tenant_id=component.tenant_id
   AND component_product.store_id=component.store_id
   AND component_product.id=component.component_product_id
  GROUP BY component.tenant_id,component.store_id,component.bundle_product_id
)
UPDATE mbox.products bundle
SET cost_amount_minor=calculated.cost_amount_minor,
    cost_source=CASE WHEN calculated.cost_amount_minor IS NULL THEN 'incomplete' ELSE 'bundle' END,
    recipe_cost_version_id=NULL,
    updated_at=clock_timestamp()
FROM calculated
WHERE bundle.tenant_id=calculated.tenant_id AND bundle.store_id=calculated.store_id
  AND bundle.id=calculated.bundle_product_id AND bundle.product_kind='bundle';

UPDATE mbox.products legacy
SET status='inactive',guest_visible=false
FROM catalog_duplicate_pairs pair
WHERE pair.tenant_id=legacy.tenant_id AND pair.store_id=legacy.store_id
  AND pair.legacy_id=legacy.id;

-- Modern catalog entries always carry an explicit sales specification. Keep
-- one active entry per normalized customer-facing name and specification,
-- while leaving legacy/imported rows without that field compatible until they
-- are edited through the managed catalog workflow.
CREATE UNIQUE INDEX products_active_customer_name_spec_uq
  ON mbox.products(
    tenant_id,store_id,
    (regexp_replace(lower(name),'[[:space:]（）()·._-]+','','g')),
    ((product_snapshot->>'salesSpecificationType'))
  )
  WHERE status IN ('active','sold_out')
    AND product_snapshot->>'salesSpecificationType'
      IN ('whole_bottle','glass','shot','cocktail','custom');

COMMENT ON INDEX mbox.products_active_customer_name_spec_uq IS
  'Prevents managed catalog products from sharing the same normalized customer-facing name and sales specification while preserving legacy rows without a specification.';

UPDATE mbox.normalized_schema_metadata
SET schema_version='156',updated_at=clock_timestamp()
WHERE singleton=true AND schema_flavor='normalized-core-v1';

COMMIT;
