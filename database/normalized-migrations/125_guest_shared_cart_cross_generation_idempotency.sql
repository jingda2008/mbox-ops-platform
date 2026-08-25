BEGIN;

ALTER TABLE mbox.guest_shared_cart_operations
  ADD COLUMN table_session_id uuid,
  ADD COLUMN scope_operation_id text;

DROP TRIGGER guest_shared_cart_operations_append_only
  ON mbox.guest_shared_cart_operations;

UPDATE mbox.guest_shared_cart_operations AS operation
SET table_session_id=cart.table_session_id
FROM mbox.guest_shared_carts AS cart
WHERE cart.tenant_id=operation.tenant_id AND cart.store_id=operation.store_id
  AND cart.id=operation.cart_id;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM mbox.guest_shared_cart_operations
    GROUP BY tenant_id,store_id,table_session_id,operation_id
    HAVING count(DISTINCT (command,payload::text))>1
  ) THEN
    RAISE EXCEPTION 'shared cart operation history contains conflicting cross-generation requests'
      USING ERRCODE='23505',HINT='Reconcile conflicting operation fingerprints before applying migration 125.';
  END IF;
END $$;

WITH ranked AS (
  SELECT id,row_number() OVER(
    PARTITION BY tenant_id,store_id,table_session_id,operation_id
    ORDER BY occurred_at,id
  ) AS duplicate_rank
  FROM mbox.guest_shared_cart_operations
)
UPDATE mbox.guest_shared_cart_operations AS operation
SET scope_operation_id=CASE WHEN ranked.duplicate_rank=1 THEN operation.operation_id
  ELSE operation.operation_id||'-legacy-'||replace(operation.id::text,'-','') END
FROM ranked WHERE ranked.id=operation.id;

ALTER TABLE mbox.guest_shared_cart_operations
  ALTER COLUMN table_session_id SET NOT NULL,
  ALTER COLUMN scope_operation_id SET NOT NULL,
  ADD CONSTRAINT guest_shared_cart_operations_scope_operation_id_check
    CHECK(length(scope_operation_id) BETWEEN 8 AND 192),
  ADD CONSTRAINT guest_shared_cart_operations_table_session_fk
    FOREIGN KEY(tenant_id,store_id,table_session_id)
    REFERENCES mbox.table_sessions(tenant_id,store_id,id);

CREATE UNIQUE INDEX guest_shared_cart_operations_table_operation_uq
  ON mbox.guest_shared_cart_operations(tenant_id,store_id,table_session_id,scope_operation_id);

CREATE TRIGGER guest_shared_cart_operations_append_only
BEFORE UPDATE OR DELETE ON mbox.guest_shared_cart_operations
FOR EACH ROW EXECUTE FUNCTION mbox.reject_row_change();

COMMENT ON COLUMN mbox.guest_shared_cart_operations.table_session_id IS
  'Stable cart-scope identity. An operation id is unique across every submitted and open generation for the same table session.';
COMMENT ON COLUMN mbox.guest_shared_cart_operations.scope_operation_id IS
  'Canonical request identity. Identical historical duplicates remain immutable with legacy suffixes; new requests use the original operation id.';

UPDATE mbox.normalized_schema_metadata
SET schema_version='125',updated_at=clock_timestamp()
WHERE singleton=true AND schema_flavor='normalized-core-v1';

COMMIT;
