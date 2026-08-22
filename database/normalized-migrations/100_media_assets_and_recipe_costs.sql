BEGIN;

-- Public-facing images are immutable binary assets. They are deliberately kept
-- separate from activity/home copy so a file can be reviewed, reused and
-- audited without turning a text field into an unbounded data bucket.
CREATE TABLE mbox.media_assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  public_id text NOT NULL CHECK (public_id ~ '^MA[0-9A-F]{32}$'),
  purpose text NOT NULL CHECK (purpose IN ('community_activity','home_content','menu','performer','support_contact')),
  original_file_name text NOT NULL CHECK (length(btrim(original_file_name)) BETWEEN 1 AND 180),
  mime_type text NOT NULL CHECK (mime_type IN ('image/jpeg','image/png','image/webp')),
  byte_length integer NOT NULL CHECK (byte_length BETWEEN 1 AND 204800),
  sha256 char(64) NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  bytes bytea NOT NULL CHECK (octet_length(bytes)=byte_length),
  created_by_employee_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id,store_id) REFERENCES mbox.stores(tenant_id,id),
  FOREIGN KEY (tenant_id,store_id,created_by_employee_id) REFERENCES mbox.employees(tenant_id,store_id,id),
  UNIQUE (tenant_id,store_id,public_id),
  UNIQUE (tenant_id,store_id,purpose,sha256),
  UNIQUE (tenant_id,store_id,id)
);

CREATE INDEX media_assets_purpose_timeline_idx
  ON mbox.media_assets(tenant_id,store_id,purpose,created_at DESC,id DESC);

CREATE TRIGGER media_assets_append_only
  BEFORE UPDATE OR DELETE ON mbox.media_assets
  FOR EACH ROW EXECUTE FUNCTION mbox.reject_row_change();

ALTER TABLE mbox.media_assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE mbox.media_assets FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_store_isolation ON mbox.media_assets
  USING (tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id())
  WITH CHECK (tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id());
REVOKE ALL ON TABLE mbox.media_assets FROM PUBLIC;
GRANT SELECT,INSERT ON TABLE mbox.media_assets TO mbox_runtime;

-- A recipe cost is explicitly applied from the then-current received material
-- costs. Later receipts can make a recalculation available, but never rewrite
-- an existing product cost or historic order cost snapshot.
CREATE TABLE mbox.recipe_cost_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  product_id uuid NOT NULL,
  recipe_id uuid NOT NULL,
  recipe_version integer NOT NULL CHECK (recipe_version>0),
  cost_amount_minor bigint NOT NULL CHECK (cost_amount_minor>=0),
  currency char(3) NOT NULL DEFAULT 'CNY' CHECK (currency ~ '^[A-Z]{3}$'),
  calculated_by_employee_id uuid NOT NULL,
  calculation_reason text NOT NULL CHECK (length(btrim(calculation_reason)) BETWEEN 2 AND 500),
  calculated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id,store_id) REFERENCES mbox.stores(tenant_id,id),
  FOREIGN KEY (tenant_id,store_id,product_id) REFERENCES mbox.products(tenant_id,store_id,id),
  FOREIGN KEY (tenant_id,store_id,recipe_id) REFERENCES mbox.recipes(tenant_id,store_id,id),
  FOREIGN KEY (tenant_id,store_id,calculated_by_employee_id) REFERENCES mbox.employees(tenant_id,store_id,id),
  UNIQUE (tenant_id,store_id,id)
);

CREATE TABLE mbox.recipe_cost_components (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  recipe_cost_version_id uuid NOT NULL,
  recipe_item_id uuid NOT NULL,
  inventory_item_id uuid NOT NULL,
  source_receipt_line_id uuid NOT NULL,
  component_quantity numeric(18,6) NOT NULL CHECK (component_quantity>0),
  expected_waste_quantity numeric(18,6) NOT NULL CHECK (expected_waste_quantity>=0),
  yield_quantity integer NOT NULL CHECK (yield_quantity>0),
  source_unit_cost_minor numeric(18,6) NOT NULL CHECK (source_unit_cost_minor>=0),
  component_cost_minor numeric(18,6) NOT NULL CHECK (component_cost_minor>=0),
  FOREIGN KEY (tenant_id,store_id) REFERENCES mbox.stores(tenant_id,id),
  FOREIGN KEY (tenant_id,store_id,recipe_cost_version_id) REFERENCES mbox.recipe_cost_versions(tenant_id,store_id,id),
  FOREIGN KEY (tenant_id,store_id,recipe_item_id) REFERENCES mbox.recipe_items(tenant_id,store_id,id),
  FOREIGN KEY (tenant_id,store_id,inventory_item_id) REFERENCES mbox.inventory_items(tenant_id,store_id,id),
  FOREIGN KEY (tenant_id,store_id,source_receipt_line_id) REFERENCES mbox.purchase_receipt_lines(tenant_id,store_id,id),
  UNIQUE (tenant_id,store_id,recipe_cost_version_id,recipe_item_id),
  UNIQUE (tenant_id,store_id,id)
);

CREATE INDEX recipe_cost_versions_product_timeline_idx
  ON mbox.recipe_cost_versions(tenant_id,store_id,product_id,calculated_at DESC,id DESC);

CREATE TRIGGER recipe_cost_versions_append_only
  BEFORE UPDATE OR DELETE ON mbox.recipe_cost_versions
  FOR EACH ROW EXECUTE FUNCTION mbox.reject_row_change();
CREATE TRIGGER recipe_cost_components_append_only
  BEFORE UPDATE OR DELETE ON mbox.recipe_cost_components
  FOR EACH ROW EXECUTE FUNCTION mbox.reject_row_change();

ALTER TABLE mbox.products
  ADD COLUMN cost_source text NOT NULL DEFAULT 'manual'
    CHECK (cost_source IN ('manual','recipe')),
  ADD COLUMN recipe_cost_version_id uuid;
ALTER TABLE mbox.products
  ADD CONSTRAINT products_recipe_cost_version_fk
  FOREIGN KEY (tenant_id,store_id,recipe_cost_version_id)
  REFERENCES mbox.recipe_cost_versions(tenant_id,store_id,id);
ALTER TABLE mbox.products
  ADD CONSTRAINT products_cost_source_version_check
  CHECK ((cost_source='manual' AND recipe_cost_version_id IS NULL)
    OR (cost_source='recipe' AND recipe_cost_version_id IS NOT NULL));

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['recipe_cost_versions','recipe_cost_components']
  LOOP
    EXECUTE format('ALTER TABLE mbox.%I ENABLE ROW LEVEL SECURITY',table_name);
    EXECUTE format('ALTER TABLE mbox.%I FORCE ROW LEVEL SECURITY',table_name);
    EXECUTE format('CREATE POLICY tenant_store_isolation ON mbox.%I USING (tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id()) WITH CHECK (tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id())',table_name);
    EXECUTE format('REVOKE ALL ON TABLE mbox.%I FROM PUBLIC',table_name);
    EXECUTE format('GRANT SELECT,INSERT ON TABLE mbox.%I TO mbox_runtime',table_name);
  END LOOP;
END $$;

UPDATE mbox.normalized_schema_metadata
SET schema_version='100',updated_at=clock_timestamp()
WHERE singleton=true AND schema_flavor='normalized-core-v1';

COMMIT;
