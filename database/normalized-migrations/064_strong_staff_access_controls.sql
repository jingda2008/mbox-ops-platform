BEGIN;

ALTER TABLE mbox.role_data_scopes
  ADD COLUMN value_kind text NOT NULL DEFAULT 'text_set'
    CHECK (value_kind IN ('boolean','text','text_set')),
  ADD COLUMN boolean_value boolean,
  ADD COLUMN text_value text,
  ADD COLUMN text_values text[] NOT NULL DEFAULT '{}';

UPDATE mbox.role_data_scopes scope
SET value_kind = CASE jsonb_typeof(scope.scope_value)
      WHEN 'boolean' THEN 'boolean'
      WHEN 'string' THEN 'text'
      ELSE 'text_set'
    END,
    boolean_value = CASE WHEN jsonb_typeof(scope.scope_value)='boolean'
      THEN (scope.scope_value::text)::boolean ELSE NULL END,
    text_value = CASE WHEN jsonb_typeof(scope.scope_value)='string'
      THEN scope.scope_value#>>'{}' ELSE NULL END,
    text_values = CASE
      WHEN jsonb_typeof(scope.scope_value)='array' THEN COALESCE((
        SELECT array_agg(DISTINCT value ORDER BY value)
        FROM jsonb_array_elements_text(scope.scope_value) AS value
      ), '{}')
      WHEN jsonb_typeof(scope.scope_value)='object' THEN COALESCE((
        SELECT array_agg(DISTINCT value ORDER BY value)
        FROM jsonb_array_elements_text(CASE
          WHEN jsonb_typeof(scope.scope_value->'values')='array' THEN scope.scope_value->'values'
          WHEN jsonb_typeof(scope.scope_value->'stationCodes')='array' THEN scope.scope_value->'stationCodes'
          WHEN jsonb_typeof(scope.scope_value->'employeeIds')='array' THEN scope.scope_value->'employeeIds'
          ELSE '[]'::jsonb END) AS value
      ), '{}')
      ELSE '{}'
    END,
    enabled = CASE WHEN jsonb_typeof(scope.scope_value) IN ('boolean','string','array')
      OR jsonb_typeof(scope.scope_value->'values')='array'
      OR jsonb_typeof(scope.scope_value->'stationCodes')='array'
      OR jsonb_typeof(scope.scope_value->'employeeIds')='array'
      THEN scope.enabled ELSE false END;

ALTER TABLE mbox.role_data_scopes
  ADD CONSTRAINT role_data_scopes_strong_value_check CHECK (
    (value_kind='boolean' AND boolean_value IS NOT NULL
      AND text_value IS NULL AND cardinality(text_values)=0)
    OR (value_kind='text' AND boolean_value IS NULL
      AND text_value IS NOT NULL AND length(btrim(text_value))>0
      AND cardinality(text_values)=0)
    OR (value_kind='text_set' AND boolean_value IS NULL AND text_value IS NULL)
  );

ALTER TABLE mbox.role_approval_limits
  ADD COLUMN calculation_mode text NOT NULL DEFAULT 'amount_limit'
    CHECK (calculation_mode IN ('amount_limit','fixed_amount','basis_points','full_gift')),
  ADD COLUMN fixed_amount_minor bigint CHECK (fixed_amount_minor IS NULL OR fixed_amount_minor > 0),
  ADD COLUMN discount_basis_points integer
    CHECK (discount_basis_points IS NULL OR discount_basis_points BETWEEN 1 AND 9999),
  ADD COLUMN allow_full_gift boolean NOT NULL DEFAULT false,
  ADD COLUMN requires_reason boolean NOT NULL DEFAULT true,
  ADD COLUMN requires_second_actor boolean NOT NULL DEFAULT false;

UPDATE mbox.role_approval_limits approval
SET calculation_mode = CASE
      WHEN approval.rules->'allowFullGift'='true'::jsonb THEN 'full_gift'
      WHEN jsonb_typeof(approval.rules->'fixedAmountMinor')='number'
        AND (approval.rules->>'fixedAmountMinor')::numeric > 0 THEN 'fixed_amount'
      WHEN jsonb_typeof(approval.rules->'discountBasisPoints')='number'
        AND (approval.rules->>'discountBasisPoints')::numeric BETWEEN 1 AND 9999 THEN 'basis_points'
      ELSE 'amount_limit'
    END,
    fixed_amount_minor = CASE
      WHEN jsonb_typeof(approval.rules->'fixedAmountMinor')='number'
        AND (approval.rules->>'fixedAmountMinor')::numeric BETWEEN 1 AND 9223372036854775807
      THEN (approval.rules->>'fixedAmountMinor')::bigint ELSE NULL END,
    discount_basis_points = CASE
      WHEN jsonb_typeof(approval.rules->'discountBasisPoints')='number'
        AND (approval.rules->>'discountBasisPoints')::numeric BETWEEN 1 AND 9999
      THEN (approval.rules->>'discountBasisPoints')::integer ELSE NULL END,
    allow_full_gift = approval.rules->'allowFullGift'='true'::jsonb,
    requires_reason = approval.rules->'requiresReason' IS DISTINCT FROM 'false'::jsonb,
    requires_second_actor = approval.rules->'requiresSecondActor'='true'::jsonb;

UPDATE mbox.role_approval_limits
SET fixed_amount_minor=NULL, discount_basis_points=NULL
WHERE calculation_mode IN ('amount_limit','full_gift');
UPDATE mbox.role_approval_limits
SET discount_basis_points=NULL, allow_full_gift=false
WHERE calculation_mode='fixed_amount';
UPDATE mbox.role_approval_limits
SET fixed_amount_minor=NULL, allow_full_gift=false
WHERE calculation_mode='basis_points';

ALTER TABLE mbox.role_approval_limits
  ADD CONSTRAINT role_approval_limits_strong_calculation_check CHECK (
    (calculation_mode='amount_limit' AND fixed_amount_minor IS NULL
      AND discount_basis_points IS NULL AND allow_full_gift=false)
    OR (calculation_mode='fixed_amount' AND fixed_amount_minor IS NOT NULL
      AND discount_basis_points IS NULL AND allow_full_gift=false)
    OR (calculation_mode='basis_points' AND fixed_amount_minor IS NULL
      AND discount_basis_points IS NOT NULL AND allow_full_gift=false)
    OR (calculation_mode='full_gift' AND fixed_amount_minor IS NULL
      AND discount_basis_points IS NULL AND allow_full_gift=true)
  );

COMMENT ON COLUMN mbox.role_data_scopes.value_kind IS
  'Strong discriminator for permission data scope values; scope_value is historical configuration evidence only.';
COMMENT ON COLUMN mbox.role_approval_limits.calculation_mode IS
  'Strong pricing/approval algorithm; rules is historical display evidence only.';

UPDATE mbox.normalized_schema_metadata
SET schema_version='064', updated_at=clock_timestamp()
WHERE singleton=true AND schema_flavor='normalized-core-v1';

COMMIT;
