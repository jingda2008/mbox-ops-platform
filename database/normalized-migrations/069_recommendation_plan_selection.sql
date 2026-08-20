BEGIN;

ALTER TABLE mbox.recommendation_options
  ADD CONSTRAINT recommendation_options_plan_reference_uq
    UNIQUE (tenant_id, store_id, id, recommendation_session_id, product_id);

ALTER TABLE mbox.customer_experience_plans
  ADD COLUMN recommendation_option_id uuid,
  ADD COLUMN selected_product_name_at_selection text,
  ADD COLUMN selected_amount_minor bigint,
  ADD COLUMN selected_currency char(3);

UPDATE mbox.customer_experience_plans plan
SET recommendation_option_id = option.id,
    selected_product_name_at_selection = product.name,
    selected_amount_minor = option.amount_minor,
    selected_currency = option.currency
FROM mbox.recommendation_options option
JOIN mbox.products product
  ON product.tenant_id=option.tenant_id AND product.store_id=option.store_id
 AND product.id=option.product_id
WHERE plan.tenant_id=option.tenant_id AND plan.store_id=option.store_id
  AND plan.recommendation_session_id=option.recommendation_session_id
  AND plan.selected_product_id=option.product_id;

ALTER TABLE mbox.customer_experience_plans
  ADD CONSTRAINT customer_experience_plans_strong_selection_check CHECK (
    (recommendation_option_id IS NULL
      AND selected_product_name_at_selection IS NULL
      AND selected_amount_minor IS NULL
      AND selected_currency IS NULL)
    OR
    (recommendation_option_id IS NOT NULL
      AND recommendation_session_id IS NOT NULL
      AND selected_product_id IS NOT NULL
      AND length(btrim(selected_product_name_at_selection)) BETWEEN 1 AND 160
      AND selected_amount_minor >= 0
      AND selected_currency ~ '^[A-Z]{3}$')
  ),
  ADD CONSTRAINT customer_experience_plans_option_selection_fk
    FOREIGN KEY (
      tenant_id, store_id, recommendation_option_id,
      recommendation_session_id, selected_product_id
    ) REFERENCES mbox.recommendation_options (
      tenant_id, store_id, id, recommendation_session_id, product_id
    );

COMMENT ON COLUMN mbox.customer_experience_plans.recommendation_option_id IS
  'Strong selected recommendation option; selected_product_snapshot is historical presentation evidence only.';
COMMENT ON COLUMN mbox.customer_experience_plans.selected_amount_minor IS
  'Recommendation amount frozen from the selected normalized option.';

UPDATE mbox.normalized_schema_metadata
SET schema_version='069', updated_at=clock_timestamp()
WHERE singleton=true AND schema_flavor='normalized-core-v1';

COMMIT;
