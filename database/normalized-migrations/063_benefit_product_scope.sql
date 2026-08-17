BEGIN;

CREATE TABLE mbox.benefit_allowed_products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  benefit_id uuid NOT NULL,
  product_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, benefit_id)
    REFERENCES mbox.benefits(tenant_id, store_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, store_id, product_id)
    REFERENCES mbox.products(tenant_id, store_id, id),
  UNIQUE (tenant_id, store_id, benefit_id, product_id),
  UNIQUE (tenant_id, store_id, id)
);

INSERT INTO mbox.benefit_allowed_products (
  tenant_id, store_id, benefit_id, product_id
)
SELECT benefit.tenant_id, benefit.store_id, benefit.id, product.id
FROM mbox.benefits benefit
CROSS JOIN LATERAL jsonb_array_elements_text(
  CASE WHEN jsonb_typeof(benefit.benefit_snapshot->'allowedProductIds')='array'
    THEN benefit.benefit_snapshot->'allowedProductIds' ELSE '[]'::jsonb END
) AS allowed(product_id)
JOIN mbox.products product
  ON product.tenant_id=benefit.tenant_id AND product.store_id=benefit.store_id
 AND product.id::text=allowed.product_id
WHERE benefit.benefit_type='gift_product'
ON CONFLICT DO NOTHING;

CREATE INDEX benefit_allowed_products_benefit_idx
  ON mbox.benefit_allowed_products (tenant_id, store_id, benefit_id, product_id);

ALTER TABLE mbox.benefit_allowed_products ENABLE ROW LEVEL SECURITY;
ALTER TABLE mbox.benefit_allowed_products FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_store_isolation ON mbox.benefit_allowed_products
  USING (tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id())
  WITH CHECK (tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id());

GRANT SELECT, INSERT, DELETE ON TABLE mbox.benefit_allowed_products TO mbox_runtime;

COMMENT ON TABLE mbox.benefit_allowed_products IS
  'Strong product eligibility for gift_product benefits; benefit_snapshot is presentation and historical evidence only.';

UPDATE mbox.normalized_schema_metadata
SET schema_version='063', updated_at=clock_timestamp()
WHERE singleton=true AND schema_flavor='normalized-core-v1';

COMMIT;
