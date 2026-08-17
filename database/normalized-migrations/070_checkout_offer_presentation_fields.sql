BEGIN;

ALTER TABLE mbox.checkout_upgrade_offers
  ADD COLUMN source_name_at_offer text,
  ADD COLUMN target_name_at_offer text,
  ADD COLUMN target_included_items text[] NOT NULL DEFAULT '{}',
  ADD COLUMN prompt_title_at_offer text,
  ADD COLUMN prompt_body_at_offer text,
  ADD COLUMN call_to_action_at_offer text;

UPDATE mbox.checkout_upgrade_offers offer
SET source_name_at_offer = source.name,
    target_name_at_offer = target.name,
    target_included_items = COALESCE((
      SELECT array_agg(component_product.name ORDER BY component.sort_order, component.id)
      FROM mbox.product_bundle_components component
      JOIN mbox.products component_product
        ON component_product.tenant_id=component.tenant_id
       AND component_product.store_id=component.store_id
       AND component_product.id=component.component_product_id
      WHERE component.tenant_id=offer.tenant_id AND component.store_id=offer.store_id
        AND component.bundle_product_id=offer.target_product_id
    ), '{}'),
    prompt_title_at_offer = rule.prompt_title,
    prompt_body_at_offer = rule.prompt_body,
    call_to_action_at_offer = rule.call_to_action
FROM mbox.products source, mbox.products target, mbox.checkout_upgrade_rules rule
WHERE source.tenant_id=offer.tenant_id AND source.store_id=offer.store_id
  AND source.id=offer.source_product_id
  AND target.tenant_id=offer.tenant_id AND target.store_id=offer.store_id
  AND target.id=offer.target_product_id
  AND rule.tenant_id=offer.tenant_id AND rule.store_id=offer.store_id
  AND rule.id=offer.rule_id;

ALTER TABLE mbox.checkout_upgrade_offers
  ADD CONSTRAINT checkout_upgrade_offers_presentation_values_check CHECK (
    (source_name_at_offer IS NULL OR length(btrim(source_name_at_offer)) BETWEEN 1 AND 160)
    AND (target_name_at_offer IS NULL OR length(btrim(target_name_at_offer)) BETWEEN 1 AND 160)
    AND cardinality(target_included_items) <= 100
    AND (prompt_title_at_offer IS NULL OR length(btrim(prompt_title_at_offer)) BETWEEN 2 AND 60)
    AND (prompt_body_at_offer IS NULL OR length(btrim(prompt_body_at_offer)) BETWEEN 2 AND 240)
    AND (call_to_action_at_offer IS NULL OR length(btrim(call_to_action_at_offer)) BETWEEN 2 AND 30)
  ),
  ADD CONSTRAINT checkout_upgrade_offers_active_presentation_check CHECK (
    status NOT IN ('offered', 'selected') OR (
      source_name_at_offer IS NOT NULL
      AND target_name_at_offer IS NOT NULL
      AND prompt_title_at_offer IS NOT NULL
      AND prompt_body_at_offer IS NOT NULL
      AND call_to_action_at_offer IS NOT NULL
    )
  );

COMMENT ON COLUMN mbox.checkout_upgrade_offers.target_included_items IS
  'Presentation list frozen from normalized bundle components; target_snapshot is historical evidence only.';

UPDATE mbox.normalized_schema_metadata
SET schema_version='070', updated_at=clock_timestamp()
WHERE singleton=true AND schema_flavor='normalized-core-v1';

COMMIT;
